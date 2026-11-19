/**
 * Azure AI Foundry (OpenAI v1) Responses API client for agent AI steps.
 *
 * - One call = one POST /responses with a strict JSON schema; the reply is
 *   parsed and returned, nothing else.
 * - The API key is sent only in the `api-key` header and is never logged.
 * - Timeouts, HTTP errors, refusals and incomplete replies all throw an
 *   AiError; callers fall back to the deterministic result.
 */

/** Provider tag frozen into versions with AI steps. */
export const AI_PROVIDER = "azure-openai-v1";

export interface AiCallInput {
  /** System-level instructions (platform rules + agent + step prompt). */
  instructions: string;
  /** Data for the model (JSON text). Treated as data, never as instructions. */
  input: string;
  schemaName: string;
  schema: Record<string, unknown>;
  maxOutputTokens?: number;
  /** Per-call limit; the client's own timeout applies when it is shorter. */
  timeoutMs?: number;
}

export interface AiCallResult {
  json: unknown;
  model: string;
  ms: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface AiClient {
  readonly model: string;
  call(req: AiCallInput): Promise<AiCallResult>;
}

export class AiError extends Error {
  constructor(
    readonly reason: "timeout" | "http" | "refused" | "incomplete" | "bad_reply" | "network",
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface AiClientOptions {
  endpoint: string;
  apiKey: string;
  deployment: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Text of the first output message, or a refusal / incomplete error. */
export function outputText(body: Record<string, unknown>): string {
  if (body.status === "incomplete") {
    const why = (body.incomplete_details as { reason?: string } | undefined)?.reason ?? "unknown";
    throw new AiError("incomplete", `The model stopped early (${why})`);
  }
  if (typeof body.output_text === "string" && body.output_text) return body.output_text;
  for (const item of (body.output as Record<string, unknown>[] | undefined) ?? []) {
    if (item.type !== "message") continue;
    for (const c of (item.content as Record<string, unknown>[] | undefined) ?? []) {
      if (c.type === "refusal") throw new AiError("refused", "The model declined the request");
      if (c.type === "output_text" && typeof c.text === "string") return c.text;
    }
  }
  throw new AiError("bad_reply", "The reply had no text");
}

export function createAiClient(opts: AiClientOptions): AiClient {
  const base = opts.endpoint.replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return {
    model: opts.deployment,
    async call(req) {
      const started = Date.now();
      const limit = Math.min(timeoutMs, req.timeoutMs ?? timeoutMs);
      let res: Response;
      try {
        res = await doFetch(`${base}/responses`, {
          method: "POST",
          headers: { "content-type": "application/json", "api-key": opts.apiKey },
          body: JSON.stringify({
            model: opts.deployment,
            instructions: req.instructions,
            input: req.input,
            store: false,
            max_output_tokens: req.maxOutputTokens ?? 4000,
            text: { format: { type: "json_schema", name: req.schemaName, strict: true, schema: req.schema } },
          }),
          signal: AbortSignal.timeout(limit),
        });
      } catch (err) {
        const name = (err as Error).name;
        if (name === "TimeoutError" || name === "AbortError") throw new AiError("timeout", `No reply within ${limit} ms`);
        throw new AiError("network", "The AI service could not be reached");
      }
      if (!res.ok) {
        // Error bodies may echo the request; keep only the service's code.
        let code: string | undefined;
        try {
          code = ((await res.json()) as { error?: { code?: string } }).error?.code;
        } catch {
          /* not JSON */
        }
        // Azure's content filter declined the input or the output.
        if (code === "content_filter") throw new AiError("refused", "content_filter", res.status);
        throw new AiError("http", `HTTP ${res.status}${code ? ` ${code}` : ""}`, res.status);
      }
      const body = (await res.json()) as Record<string, unknown>;
      const text = outputText(body);
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new AiError("bad_reply", "The reply was not valid JSON");
      }
      const usage = body.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      return {
        json,
        model: typeof body.model === "string" ? body.model : opts.deployment,
        ms: Date.now() - started,
        inputTokens: usage?.input_tokens ?? null,
        outputTokens: usage?.output_tokens ?? null,
      };
    },
  };
}
