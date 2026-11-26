import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.string().default("info"),
  DB_SERVER: z.string().min(1),
  DB_NAME: z.string().min(1),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  CRE_TENANT_ID: z.string().uuid(),
  CRE_API_CLIENT_ID: z.string().uuid(),
  CRE_REQUIRED_SCOPE: z.string().default("access_as_user"),
  AUTO_PROVISION_TENANT_ID: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : undefined))
    .pipe(z.string().uuid().optional()),
  // AI steps (Azure AI Foundry, OpenAI v1 Responses API). No key = AI steps
  // are reported as not configured and runs stay deterministic.
  AI_ENDPOINT: z.string().url().default("https://cre-openai-service-resource.services.ai.azure.com/openai/v1"),
  AI_API_KEY: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : undefined)),
  AI_DEPLOYMENT: z.string().min(1).default("CREAgentStudio__gpt-6.1-sol"),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  // Optional: USD per million tokens, for the cost estimate on Monitoring.
  AI_PRICE_INPUT_PER_MTOK: z.preprocess((v) => (v === "" || v == null ? undefined : v), z.coerce.number().nonnegative().optional()),
  AI_PRICE_OUTPUT_PER_MTOK: z.preprocess((v) => (v === "" || v == null ? undefined : v), z.coerce.number().nonnegative().optional()),
  // CRE protocol service, for scanned referrals (upload + OCR), the same one CRE web uses (the dev
  // API management has no CRE service). The user's CRE token is used.
  CRE_API_BASE_URL: z.string().url().default("https://prod-cre-apim.azure-api.net/CreReportingMicroservice"),
  // Built web app served by this server (web/dist). Empty = API only. Default: ../web/dist when it exists.
  WEB_DIR: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : undefined)),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Report which settings are missing or invalid, never their values.
    const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid configuration: ${fields}`);
  }
  return parsed.data;
}
