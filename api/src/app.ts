import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { KnowledgeService } from "./knowledge/service.js";
import { AppError } from "./errors.js";
import { AgentService } from "./agents/service.js";
import { registerAgentRoutes } from "./agents/routes.js";
import { RunService } from "./runtime/service.js";
import { registerRunRoutes } from "./runtime/routes.js";
import { MonitoringService, type AiPrice } from "./runtime/monitoring.js";
import { ReleaseService } from "./release/service.js";
import { registerReleaseRoutes } from "./release/routes.js";
import { registerKnowledgeRoutes } from "./knowledge/routes.js";
import type { Db } from "./db/pool.js";
import { AI_PROVIDER, type AiClient } from "./runtime/aiClient.js";
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
  /** AI steps; null/undefined = not configured (deterministic runs). */
  ai?: AiClient | null;
  /** AI token prices for the monitoring cost estimate; null = tokens only. */
  aiPrice?: AiPrice | null;
  /**
   * Built web app (web/dist). When set, one server hosts both: the web app at
   * "/" (any unknown page → index.html) and the API under "/api", the same
   * paths the web app uses in development. Without it the API is at "/".
   */
  webDir?: string | null;
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

  const webDir = deps.webDir && fs.existsSync(path.join(deps.webDir, "index.html")) ? path.resolve(deps.webDir) : null;

  const api = async (app: FastifyInstance) => {
  app.get("/health", async () => {
    await deps.db.request().query("SELECT 1 AS ok");
    return { status: "ok" };
  });

  app.get("/me", { preHandler: requireUser }, async (req) => ({ user: req.user }));

  app.register(async (scope) => registerKnowledgeRoutes(scope, new KnowledgeService(deps.db), requireUser));
  app.register(async (scope) => registerAgentRoutes(scope, new AgentService(deps.db, deps.ai ? { provider: AI_PROVIDER, deployment: deps.ai.model } : null), requireUser));
  app.register(async (scope) => registerRunRoutes(scope, new RunService(deps.db, deps.ai ?? null), requireUser, new MonitoringService(deps.db, deps.aiPrice ?? null)));
  app.register(async (scope) => registerReleaseRoutes(scope, new ReleaseService(deps.db), requireUser));
  };

  // Known errors keep their status and code; anything else is a 500 without details.
  app.setErrorHandler((err, req, reply) => {
    const e = err as Error & { statusCode?: number; code?: string };
    if (e instanceof AppError) return reply.code(e.statusCode).send({ error: e.code, message: e.message });
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.code ?? "error", message: e.message });
    req.log.error({ err: e }, "request failed");
    return reply.code(500).send({ error: "internal", message: "Something went wrong" });
  });

  // Every :id in the API is a UUID: anything else is simply not found (never a database error).
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  app.addHook("preValidation", async (req) => {
    const id = (req.params as Record<string, string> | undefined)?.id;
    if (id !== undefined && !UUID.test(id)) throw new AppError(404, "not_found", "Not found");
  });

  app.register(multipart);

  if (!webDir) {
    app.register(api);
    return app;
  }

  app.register(api, { prefix: "/api" });
  // index.html is never cached (a new deploy is picked up at once); hashed assets are.
  app.register(fastifyStatic, {
    root: webDir,
    wildcard: false,
    index: false,
    cacheControl: false, // set below
    setHeaders: (res, file) => {
      res.setHeader(
        "Cache-Control",
        file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
      );
    },
  });
  app.setNotFoundHandler((req, reply) => {
    const url = req.url.split("?")[0];
    const isApi = url === "/api" || url.startsWith("/api/");
    // A page of the web app (e.g. /agents/…) → the app itself; a missing file or API route → 404.
    if (req.method === "GET" && !isApi && !path.extname(url)) {
      return reply.header("Cache-Control", "no-cache").type("text/html").sendFile("index.html");
    }
    return reply.code(404).send({ error: "not_found", message: "Not found" });
  });

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
