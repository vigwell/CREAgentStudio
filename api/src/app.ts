import Fastify, { type FastifyRequest } from "fastify";
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
}

export function buildApp(deps: AppDeps) {
  const app = Fastify({
    logger: {
      level: deps.logLevel ?? "info",
      // Never log credentials.
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
  });

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
    const user = await resolveUser(deps.db, identity, deps.autoProvisionTenantId);
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
