import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { createCreTokenVerifier } from "./auth/creToken.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { createAiClient } from "./runtime/aiClient.js";

const config = loadConfig();
// The built server (api/dist/server.js) also hosts <repo>/web/dist. In
// development (tsx, src/server.ts) the API stays at "/" behind Vite's /api proxy.
const builtServer = fileURLToPath(import.meta.url).includes(`${path.sep}dist${path.sep}`);
const webDir = config.WEB_DIR ?? (builtServer ? fileURLToPath(new URL("../../web/dist", import.meta.url)) : null);
const db = await createPool(config);
const app = buildApp({
  db,
  verifyToken: createCreTokenVerifier({
    tenantId: config.CRE_TENANT_ID,
    audience: config.CRE_API_CLIENT_ID,
    requiredScope: config.CRE_REQUIRED_SCOPE,
  }),
  autoProvisionTenantId: config.AUTO_PROVISION_TENANT_ID,
  logLevel: config.LOG_LEVEL,
  webDir,
  aiPrice:
    config.AI_PRICE_INPUT_PER_MTOK != null && config.AI_PRICE_OUTPUT_PER_MTOK != null
      ? { inputPerMTok: config.AI_PRICE_INPUT_PER_MTOK, outputPerMTok: config.AI_PRICE_OUTPUT_PER_MTOK }
      : null,
  ai: config.AI_API_KEY
    ? createAiClient({ endpoint: config.AI_ENDPOINT, apiKey: config.AI_API_KEY, deployment: config.AI_DEPLOYMENT, timeoutMs: config.AI_TIMEOUT_MS })
    : null,
});
app.log.info({ ai: config.AI_API_KEY ? config.AI_DEPLOYMENT : "not configured" }, "AI steps");
app.log.info({ web: webDir }, "web app (served when its index.html exists; API under /api)");

const close = async () => {
  await app.close();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", close);
process.on("SIGTERM", close);

await app.listen({ port: config.PORT, host: "0.0.0.0" });
