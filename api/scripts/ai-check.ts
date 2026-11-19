/**
 * npm run ai:check: one small request to the configured AI deployment with
 * synthetic text, to confirm the endpoint, key and deployment work.
 * Prints the model, latency and result; never prints the key.
 */
import { loadConfig } from "../src/config.js";
import { createAiClient } from "../src/runtime/aiClient.js";

const config = loadConfig();
if (!config.AI_API_KEY) {
  console.error("AI_API_KEY is not set in .env; AI steps run as 'not set up'.");
  process.exit(1);
}
const ai = createAiClient({ endpoint: config.AI_ENDPOINT, apiKey: config.AI_API_KEY, deployment: config.AI_DEPLOYMENT, timeoutMs: config.AI_TIMEOUT_MS });
console.log(`Endpoint: ${config.AI_ENDPOINT}\nDeployment: ${config.AI_DEPLOYMENT}`);
try {
  const r = await ai.call({
    instructions: 'Extract the age in years from the note. Reply with {"age": "<digits>", "quote": "<exact words>"}.',
    input: JSON.stringify({ clinicalNote: "Synthetic test note: 58 year old, headache for 3 weeks." }),
    schemaName: "check",
    schema: { type: "object", additionalProperties: false, required: ["age", "quote"], properties: { age: { type: "string" }, quote: { type: "string" } } },
    maxOutputTokens: 1000,
  });
  console.log(`OK: model ${r.model}, ${r.ms} ms, tokens in/out ${r.inputTokens}/${r.outputTokens}`);
  console.log("Reply:", JSON.stringify(r.json));
} catch (err) {
  const e = err as { reason?: string; message: string };
  console.error(`Failed (${e.reason ?? "error"}): ${e.message}`);
  process.exit(1);
}
