/** CDS run HTTP API: start (idempotent), get, list per agent, review a finding. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { RunService, type RunRequest } from "./service.js";

const Run = z.object({
  agentId: z.string().uuid(),
  candidateId: z.string().uuid(),
  caseRef: z.string().min(1).max(200),
  deviceId: z.string().max(100).nullable().optional(),
  executionMode: z.enum(["standalone_cds", "report_context"]).optional(),
  reportContext: z.unknown().optional(),
  inputs: z.object({ manualValues: z.record(z.string(), z.unknown()).optional() }).optional(),
});
const Review = z.object({
  findingIndex: z.number().int().min(0),
  action: z.string(),
  reason: z.string().max(1000).nullable().optional(),
  snapshotHash: z.string(),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new AppError(422, "bad_request", r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return r.data;
}

export function registerRunRoutes(app: FastifyInstance, service: RunService, requireUser: (req: FastifyRequest) => Promise<void>) {
  const auth = { preHandler: requireUser };
  const id = (req: FastifyRequest) => (req.params as { id: string }).id;
  app.post("/runs", auth, async (req, reply) => {
    const key = req.headers["idempotency-key"];
    const r = await service.start(req.user!, Array.isArray(key) ? key[0] : key, parse(Run, req.body) as RunRequest);
    reply.code(r.replayed ? 200 : 201);
    return service.get(req.user!, r.runId);
  });
  app.get("/runs/:id", auth, async (req) => service.get(req.user!, id(req)));
  app.get("/agents/:id/runs", auth, async (req) => ({ runs: await service.list(req.user!, id(req)) }));
  app.post("/runs/:id/reviews", auth, async (req, reply) => {
    reply.code(201);
    return service.review(req.user!, id(req), parse(Review, req.body));
  });
}
