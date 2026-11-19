/** Release HTTP API: test cases, candidate tests, approval, activation, withdrawal, diff. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { ReleaseService, type TestCaseInput } from "./service.js";

const Step = z.object({ nodeId: z.string().min(1), state: z.string(), port: z.string().optional() });
const TestCase = z.object({
  name: z.string().max(200),
  inputs: z.object({ manualValues: z.record(z.string(), z.unknown()), deviceId: z.string().max(100).nullable().optional() }),
  expected: z.object({
    outcome: z.string(),
    findingCodes: z.array(z.string()).max(50).optional(),
    path: z.array(Step).max(60).optional(),
    blockedCategories: z.array(z.string()).max(20).optional(),
  }),
  version: z.number().int().optional(),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new AppError(422, "bad_request", r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return r.data;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerReleaseRoutes(app: FastifyInstance, service: ReleaseService, requireUser: (req: FastifyRequest) => Promise<void>) {
  const auth = { preHandler: requireUser };
  const p = (req: FastifyRequest) => req.params as { id: string; testCaseId?: string };
  const tcId = (req: FastifyRequest) => {
    const v = p(req).testCaseId ?? "";
    if (!UUID.test(v)) throw new AppError(404, "not_found", "Not found");
    return v;
  };

  app.get("/agents/:id/test-cases", auth, async (req) => ({ testCases: await service.listTestCases(req.user!, p(req).id) }));
  app.post("/agents/:id/test-cases", auth, async (req, reply) => {
    reply.code(201);
    return service.createTestCase(req.user!, p(req).id, parse(TestCase, req.body) as TestCaseInput);
  });
  app.put("/agents/:id/test-cases/:testCaseId", auth, async (req) => service.updateTestCase(req.user!, p(req).id, tcId(req), parse(TestCase, req.body) as TestCaseInput));
  app.delete("/agents/:id/test-cases/:testCaseId", auth, async (req) => service.deleteTestCase(req.user!, p(req).id, tcId(req)));

  app.get("/agents/:id/versions", auth, async (req) => ({ versions: await service.listCandidates(req.user!, p(req).id) }));
  app.post("/candidates/:id/tests", auth, async (req, reply) => {
    reply.code(201);
    return service.runTests(req.user!, p(req).id);
  });
  app.get("/candidates/:id/tests", auth, async (req) => ({ testRun: await service.testRun(req.user!, p(req).id) }));
  app.post("/candidates/:id/approve", auth, async (req) => service.approve(req.user!, p(req).id));
  app.post("/candidates/:id/activate", auth, async (req) => service.activate(req.user!, p(req).id));
  app.post("/candidates/:id/withdraw", auth, async (req) =>
    service.withdraw(req.user!, p(req).id, parse(z.object({ reason: z.string().max(500) }), req.body ?? {}).reason),
  );
  app.get("/candidates/:id/diff", auth, async (req) => {
    const against = (req.query as { against?: string }).against;
    if (against && !UUID.test(against)) throw new AppError(404, "not_found", "Not found");
    return service.diff(req.user!, p(req).id, against ?? null);
  });
}
