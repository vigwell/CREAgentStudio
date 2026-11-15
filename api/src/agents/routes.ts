/** Agent authoring and clinic & exam profile HTTP API. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { BLOCKS, OPERATORS } from "./blocks.js";
import { MANDATORY_RULES, OPTIONAL_RULES, OUTPUT_CATEGORIES } from "./policy.js";
import { AgentService, type DraftInput, type ProfileInput } from "./service.js";

const Prompt = z.object({ promptId: z.string().nullable().optional(), revisionId: z.string().nullable().optional(), draftText: z.string().max(20_000).nullable().optional() });
const Node = z.object({
  id: z.string(),
  type: z.string(),
  label: z.string().max(200),
  executionKind: z.enum(["deterministic", "ai"]).optional(),
  prompt: Prompt.nullable().optional(),
  inputBindings: z.record(z.string(), z.object({ nodeId: z.string(), field: z.string() })).optional(),
  condition: z.object({ nodeId: z.string(), field: z.string(), operator: z.string(), value: z.unknown().optional() }).nullable().optional(),
  knowledgeRevisionId: z.string().nullable().optional(),
  clinicProfileId: z.string().nullable().optional(),
  outputCategories: z.array(z.string()).optional(),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
});
const Draft = z.object({
  version: z.number().int().min(1),
  graph: z.object({ nodes: z.array(Node), edges: z.array(z.object({ id: z.string(), from: z.string(), port: z.string(), to: z.string() })) }),
  agentPrompt: Prompt.nullable(),
  prohibitions: z.object({
    optional: z.array(z.string()),
    custom: z.array(
      z.object({
        id: z.string(),
        text: z.string().min(1).max(500),
        owner: z.string().max(200),
        binding: z.union([z.object({ type: z.literal("deny_output"), category: z.string() }), z.object({ type: z.literal("deny_capability"), capability: z.string() })]).nullable(),
        reviewed: z.boolean(),
      }),
    ),
  }),
});
const Profile = z.object({
  name: z.string(),
  site: z.string(),
  department: z.string(),
  subdepartment: z.string().nullable().optional(),
  risProcedureCode: z.string(),
  protocolRevisionId: z.string().uuid().nullable().optional(),
  protocolCode: z.string().nullable().optional(),
  questions: z.array(z.object({ id: z.string(), text: z.string(), answerType: z.enum(["yes_no", "number", "text"]), contraindicationIf: z.unknown().optional() })).optional(),
  horizonDays: z.number().int(),
  instructionRevisionId: z.string().uuid().nullable().optional(),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new AppError(400, "bad_request", r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return r.data;
}

export function registerAgentRoutes(app: FastifyInstance, service: AgentService, requireUser: (req: FastifyRequest) => Promise<void>) {
  const auth = { preHandler: requireUser };
  const id = (req: FastifyRequest) => (req.params as { id: string }).id;

  app.get("/agents/catalog", auth, async () => ({
    blocks: BLOCKS,
    operators: OPERATORS,
    mandatoryRules: MANDATORY_RULES,
    optionalRules: OPTIONAL_RULES,
    outputCategories: OUTPUT_CATEGORIES,
  }));
  app.get("/agents", auth, async (req) => ({ agents: await service.list(req.user!) }));
  app.post("/agents", auth, async (req, reply) => {
    const body = parse(
      z.object({ kind: z.enum(["cds", "voice"]), name: z.string(), intendedUse: z.string(), scope: z.record(z.string(), z.unknown()).default({}), executionMode: z.string().optional() }),
      req.body,
    );
    reply.code(201);
    return service.create(req.user!, { ...body, scope: body.scope ?? {} });
  });
  app.get("/agents/:id", auth, async (req) => service.get(req.user!, id(req)));
  app.put("/agents/:id/draft", auth, async (req) => service.saveDraft(req.user!, id(req), parse(Draft, req.body) as DraftInput));
  app.post("/agents/:id/compile", auth, async (req) => service.compileDraft(req.user!, id(req)));
  app.post("/agents/:id/candidates", auth, async (req, reply) => {
    reply.code(201);
    return service.createCandidate(req.user!, id(req));
  });
  app.get("/agents/:id/candidates", auth, async (req) => ({ candidates: await service.candidates(req.user!, id(req)) }));

  app.get("/clinic-profiles", auth, async (req) => ({ profiles: await service.listProfiles(req.user!) }));
  app.post("/clinic-profiles", auth, async (req, reply) => {
    reply.code(201);
    return service.createProfile(req.user!, parse(Profile, req.body) as ProfileInput);
  });
  app.post("/clinic-profiles/:id/revisions", auth, async (req, reply) => {
    reply.code(201);
    return service.createProfile(req.user!, parse(Profile, req.body) as ProfileInput, id(req));
  });
  app.post("/clinic-profiles/:id/approve", auth, async (req) => service.approveProfile(req.user!, id(req)));
  app.post("/clinic-profiles/:id/withdraw", auth, async (req) => service.withdrawProfile(req.user!, id(req)));
}
