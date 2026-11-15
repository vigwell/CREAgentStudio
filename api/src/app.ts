import Fastify, { type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import { KnowledgeError, KnowledgeService } from "./knowledge/service.js";
import { registerKnowledgeRoutes } from "./knowledge/routes.js";
import type { Db } from "./db/pool.js";
import { AuthError, bearerToken, type CreIdentity } from "./auth/creToken.js";
import { resolveUser, type StudioUser } from "./services/users.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: StudioUser;
  }
}

export interface AppDeps {
  db: Db;
  verifyToken: (token: string) => Promise<CreIdentity>;
  autoProvisionTenantId?: string;
  logLevel?: string;
  /** How long a resolved Studio user (role, tenant) is reused; 0 = every request. */
  userCacheMs?: number;
}

export function buildApp(deps: AppDeps) {
  const app = Fastify({
    logger: {
      level: deps.logLevel ?? "info",
      // Never log credentials.
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
  });

  const userCache = new Map<string, { user: StudioUser; until: number }>();
  const USER_CACHE_MS = deps.userCacheMs ?? 60_000;

  async function requireUser(req: FastifyRequest) {
    const token = bearerToken(req.headers.authorization);
    if (!token) throw app.httpErrors.unauthorized("missing bearer token");
    let identity: CreIdentity;
    try {
      identity = await deps.verifyToken(token);
    } catch (err) {
      if (err instanceof AuthError) throw app.httpErrors.unauthorized(err.message);
      throw err;
    }
    // Short cache: one database lookup per user per minute instead of per request.
    const cached = userCache.get(identity.oid);
    let user = cached && cached.until > Date.now() ? cached.user : null;
    if (!user) {
      user = await resolveUser(deps.db, identity, deps.autoProvisionTenantId);
      if (user) userCache.set(identity.oid, { user, until: Date.now() + USER_CACHE_MS });
      else userCache.delete(identity.oid);
    }
    if (!user) throw app.httpErrors.forbidden("no CRE Agent Studio access for this account");
    req.user = user;
  }

  app.decorate("httpErrors", {
    unauthorized: (m: string) => Object.assign(new Error(m), { statusCode: 401 }),
    forbidden: (m: string) => Object.assign(new Error(m), { statusCode: 403 }),
  });

  app.get("/health", async () => {
    await deps.db.request().query("SELECT 1 AS ok");
    return { status: "ok" };
  });

  app.get("/me", { preHandler: requireUser }, async (req) => ({ user: req.user }));

  // Known errors keep their status and code; anything else is a 500 without details.
  app.setErrorHandler((err, req, reply) => {
    const e = err as Error & { statusCode?: number; code?: string };
    if (e instanceof KnowledgeError) return reply.code(e.statusCode).send({ error: e.code, message: e.message });
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.code ?? "error", message: e.message });
    req.log.error({ err: e }, "request failed");
    return reply.code(500).send({ error: "internal", message: "Something went wrong" });
  });

  app.register(multipart);
  app.register(async (scope) => registerKnowledgeRoutes(scope, new KnowledgeService(deps.db), requireUser));

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    httpErrors: {
      unauthorized: (m: string) => Error;
      forbidden: (m: string) => Error;
    };
  }
}
