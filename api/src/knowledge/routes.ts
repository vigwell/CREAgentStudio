/** Knowledge Library HTTP API (all routes need a signed-in Studio user). */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { FIELDS, REQUIRED_BY_KIND, SOURCE_KINDS } from "./fields.js";
import { MAX_FILE_BYTES } from "./spreadsheet.js";
import { KnowledgeError, KnowledgeService } from "./service.js";

const RevisionBody = z.object({
  fileId: z.string().uuid(),
  sheet: z.string().min(1).nullable().default(null),
  headerRow: z.number().int().min(1),
  mapping: z.record(z.string().min(1), z.string().min(1)),
  scope: z.record(z.string(), z.unknown()).nullable().optional(),
  clinicalOwner: z.string().min(1).max(200),
  effectiveFrom: z.string().nullable().optional(),
  reviewDue: z.string(),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) {
    throw new KnowledgeError(400, "bad_request", r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  }
  return r.data;
}

export function registerKnowledgeRoutes(
  app: FastifyInstance,
  service: KnowledgeService,
  requireUser: (req: FastifyRequest) => Promise<void>,
) {
  const auth = { preHandler: requireUser };

  app.get("/knowledge/fields", auth, async () => ({ kinds: SOURCE_KINDS, fields: FIELDS, requiredByKind: REQUIRED_BY_KIND }));

  app.post("/knowledge/files", auth, async (req, reply) => {
    const part = await req.file({ limits: { fileSize: MAX_FILE_BYTES, files: 1 } });
    if (!part) throw new KnowledgeError(400, "file_required", "Upload one .xlsx or .csv file");
    const content = await part.toBuffer().catch(() => {
      throw new KnowledgeError(413, "too_large", "The file is larger than 10 MB");
    });
    if (part.file.truncated) throw new KnowledgeError(413, "too_large", "The file is larger than 10 MB");
    reply.code(201);
    return service.uploadFile(req.user!, part.filename, content);
  });

  app.get("/knowledge/files/:id/preview", auth, async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { sheet?: string; headerRow?: string };
    return service.preview(req.user!, id, q.sheet ?? null, Number(q.headerRow ?? 1) || 1);
  });

  app.get("/knowledge/sources", auth, async (req) => ({ sources: await service.listSources(req.user!) }));

  app.post("/knowledge/sources", auth, async (req, reply) => {
    const body = parse(z.object({ kind: z.string(), name: z.string(), issuingOrg: z.string().nullable().optional() }), req.body);
    reply.code(201);
    return service.createSource(req.user!, body);
  });

  app.post("/knowledge/sources/:id/revisions", auth, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parse(RevisionBody, req.body);
    reply.code(201);
    return service.createRevision(req.user!, id, { ...body, sheet: body.sheet ?? null });
  });

  app.get("/knowledge/revisions/:id", auth, async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { page?: string; pageSize?: string };
    return service.getRevision(req.user!, id, Number(q.page ?? 0) || 0, Number(q.pageSize ?? 100) || 100);
  });

  app.post("/knowledge/revisions/:id/submit", auth, async (req) => service.submit(req.user!, (req.params as { id: string }).id));
  app.post("/knowledge/revisions/:id/approve", auth, async (req) => service.approve(req.user!, (req.params as { id: string }).id));
  app.post("/knowledge/revisions/:id/return", auth, async (req) => {
    const body = parse(z.object({ reason: z.string().min(1) }), req.body);
    return service.returnToDraft(req.user!, (req.params as { id: string }).id, body.reason);
  });
  app.post("/knowledge/revisions/:id/withdraw", auth, async (req) => {
    const body = parse(z.object({ reason: z.string().min(1) }), req.body);
    return service.withdraw(req.user!, (req.params as { id: string }).id, body.reason);
  });
}
