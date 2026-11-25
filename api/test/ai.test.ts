import { describe, expect, it, vi } from "vitest";
import { AiError, createAiClient, outputText, type AiCallInput, type AiClient } from "../src/runtime/aiClient.js";
import { numbersSupported, runAgent, verifyExtracted } from "../src/runtime/aiSteps.js";
import type { InputSnapshot, KnowledgeBinding, Manifest } from "../src/runtime/engine.js";

const protocols: KnowledgeBinding = {
  revisionId: "rev-p",
  sourceName: "CT 01 protocols",
  kind: "device_protocol",
  status: "approved",
  rows: [{ rowId: "P01", sheet: "Protocols", originalRow: 8, mapped: { protocolCode: "CT-HEAD-01", conditionCode: "DEMO-A" }, hasErrors: false }],
};
const k = new Map([["rev-p", protocols]]);

function manifest(opts: { extractAi?: boolean; synthAi?: boolean; maxAiCalls?: number; synthPrompt?: string | null; denied?: string } = {}): Manifest {
  const m = {
    agentId: "a1",
    executionMode: "standalone_cds",
    scope: {},
    agentPrompt: { draftText: "Check CT head referrals for adults." },
    budget: { maxAiCalls: opts.maxAiCalls ?? 2 },
    nodes: [
      { id: "start", type: "start", label: "Request", executionKind: "deterministic", condition: null, knowledgeRevisionId: null, outputCategories: [] },
      { id: "patient", type: "patient_service", label: "Patient", executionKind: opts.extractAi ? "ai" : "deterministic", prompt: null, condition: null, knowledgeRevisionId: null, outputCategories: [] },
      { id: "has", type: "decision", label: "Has indication?", executionKind: "deterministic", condition: { nodeId: "patient", field: "hasIndication", operator: "eq", value: true }, knowledgeRevisionId: null, outputCategories: [] },
      { id: "lookup", type: "protocol_lookup", label: "Protocol", executionKind: "deterministic", condition: null, knowledgeRevisionId: "rev-p", outputCategories: [] },
      { id: "note", type: "instruction", label: "Ask the referrer for an indication", executionKind: "deterministic", condition: null, knowledgeRevisionId: null, outputCategories: [] },
      {
        id: "final",
        type: "final_synthesis",
        label: "Summary",
        executionKind: opts.synthAi === false ? "deterministic" : "ai",
        prompt: { draftText: opts.synthPrompt === undefined ? "Two sentences for the radiologist." : opts.synthPrompt },
        condition: null,
        knowledgeRevisionId: null,
        outputCategories: ["protocol_match", "safety_flag"],
      },
    ],
    edges: [
      { id: "e1", from: "start", port: "out", to: "patient" },
      { id: "e2", from: "patient", port: "out", to: "has" },
      { id: "e3", from: "has", port: "yes", to: "lookup" },
      { id: "e4", from: "has", port: "no", to: "note" },
      { id: "e5", from: "lookup", port: "out", to: "final" },
      { id: "e6", from: "note", port: "out", to: "final" },
    ],
    effectivePolicy: { rules: opts.denied ? [{ id: "P09", binding: { type: "deny_output", category: opts.denied } }] : [] },
  };
  return m as unknown as Manifest;
}

const manual = (value: unknown) => ({ value, status: "present" as const, sourceRef: "manual", observedAt: "2026-11-15T08:00:00Z", attribution: { kind: "manual" as const, userId: "u1" } });
const snap = (facts: InputSnapshot["facts"]): InputSnapshot => ({ caseRef: "case-1", requestedAt: "2026-11-15T08:00:00Z", facts });
const NOTE = "58 y/o woman. Indication code DEMO-A, headache for 3 weeks. No known contrast allergy. eGFR 72.";

/** Fake AI: answers per schema name, records every call. */
function fakeAi(answers: Record<string, unknown | Error>): AiClient & { calls: AiCallInput[] } {
  const calls: AiCallInput[] = [];
  return {
    model: "fake-model",
    calls,
    async call(req) {
      calls.push(req);
      const a = answers[req.schemaName];
      if (a instanceof Error) throw a;
      return { json: a, model: "fake-model", ms: 5, inputTokens: 10, outputTokens: 5 };
    },
  };
}

describe("verifyExtracted", () => {
  it("accepts a value only when its quote is in the note and contains it", () => {
    expect(verifyExtracted(NOTE, "egfr", "72", "eGFR 72")).toBe(72);
    expect(verifyExtracted(NOTE, "egfr", "80", "eGFR 72")).toBeNull(); // value not in quote
    expect(verifyExtracted(NOTE, "egfr", "72", "eGFR is 72")).toBeNull(); // quote not verbatim
    expect(verifyExtracted(NOTE, "ageYears", "58", "58 y/o")).toBe(58);
    expect(verifyExtracted(NOTE, "indicationCode", "DEMO-A", "Indication code DEMO-A")).toBe("DEMO-A");
    expect(verifyExtracted(NOTE, "indicationCode", "DEMO-B", "Indication code DEMO-A")).toBeNull();
    expect(verifyExtracted(NOTE, "contrastAllergy", "false", "No known contrast allergy")).toBe(false);
    expect(verifyExtracted(NOTE, "contrastAllergy", "maybe", "No known contrast allergy")).toBeNull();
    expect(verifyExtracted(NOTE, "sex", "female", "woman")).toBe("female");
    expect(verifyExtracted(NOTE, "records", "x", "woman")).toBeNull(); // not extractable
    expect(verifyExtracted(NOTE, "egfr", "72", "")).toBeNull();
  });

  it("matches across whitespace and case differences", () => {
    expect(verifyExtracted("eGFR\n  72 ml/min", "egfr", "72", "egfr 72")).toBe(72);
  });
});

describe("numbersSupported", () => {
  it("rejects numbers the model wasn't given", () => {
    expect(numbersSupported("Protocol CT-HEAD-01 matches (row 8).", '{"row":8,"code":"CT-HEAD-01"}')).toBe(true);
    expect(numbersSupported("Give 50 mg.", '{"row":8}')).toBe(false);
    expect(numbersSupported("No numbers here.", "{}")).toBe(true);
  });
});

describe("runAgent", () => {
  it("without AI configured: deterministic result, steps say AI is not set up", async () => {
    const r = await runAgent(manifest({ extractAi: true }), snap({ indicationCode: manual("DEMO-A"), clinicalNote: manual(NOTE) }), k, null);
    expect(r.outcome).toBe("findings");
    expect(r.summary?.ai).toBe("not_configured");
    expect(r.aiCalls?.map((c) => [c.purpose, c.status])).toEqual([
      ["extraction", "not_configured"],
      ["synthesis", "not_configured"],
    ]);
    expect(r.trace.find((t) => t.nodeId === "final")?.ai?.status).toBe("not_configured");
  });

  it("extraction fills missing fields from the note; values feed the decision and lookup; quotes kept", async () => {
    const ai = fakeAi({
      patient_facts: {
        values: [
          { field: "indicationCode", value: "DEMO-A", quote: "Indication code DEMO-A" },
          { field: "egfr", value: "72", quote: "eGFR 72" },
          { field: "pregnant", value: "false", quote: "not pregnant" }, // not in the note: dropped
        ],
      },
      cds_summary: { summary: "Local protocol CT-HEAD-01 matches (CT 01 protocols, row 8); please review." },
    });
    const r = await runAgent(manifest({ extractAi: true }), snap({ clinicalNote: manual(NOTE) }), k, ai);
    expect(r.outcome).toBe("findings");
    const f = r.findings.find((x) => x.code === "PROTOCOL_MATCH_REVIEW")!;
    const ind = f.observedInputs.find((o) => o.field === "indicationCode")!;
    expect(ind.attribution).toBe("ai");
    expect(ind.quote).toBe("Indication code DEMO-A");
    const step = r.trace.find((t) => t.nodeId === "patient")!;
    expect(step.ai).toEqual({ status: "used", fields: ["indicationCode", "egfr"], reason: "dropped_1" });
    expect(step.note).toBeUndefined();
    expect(r.summary).toEqual({ text: expect.stringContaining("CT-HEAD-01"), ai: "used", model: "fake-model" });
    expect(ai.calls).toHaveLength(2);
    // The case reference is never sent; the note is sent as data.
    expect(ai.calls.map((c) => c.input).join(" ")).not.toContain("case-1");
    expect(ai.calls[0].input).toContain("eGFR 72");
  });

  it("structured values always win over the note", async () => {
    const ai = fakeAi({ patient_facts: { values: [{ field: "indicationCode", value: "DEMO-A", quote: "Indication code DEMO-A" }] }, cds_summary: { summary: "ok" } });
    const r = await runAgent(manifest({ extractAi: true }), snap({ indicationCode: manual("DEMO-Z"), clinicalNote: manual(NOTE) }), k, ai);
    expect(ai.calls[0].instructions).not.toMatch(/needed: [^\n]*indicationCode/);
    expect(r.findings[0].code).toBe("PROTOCOL_NO_MATCH");
  });

  it("no note: no extraction call, the run asks for input as before", async () => {
    const ai = fakeAi({ cds_summary: { summary: "x" } });
    const r = await runAgent(manifest({ extractAi: true }), snap({}), k, ai);
    expect(r.outcome).toBe("needs_input");
    expect(ai.calls).toHaveLength(0);
    expect(r.trace.find((t) => t.nodeId === "patient")?.ai?.status).toBe("no_note");
  });

  it("AI failure falls back to the deterministic summary; the run still completes", async () => {
    const ai = fakeAi({ patient_facts: new AiError("timeout", "slow"), cds_summary: new AiError("http", "HTTP 500", 500) });
    const r = await runAgent(manifest({ extractAi: true }), snap({ indicationCode: manual("DEMO-A"), clinicalNote: manual(NOTE) }), k, ai);
    expect(r.state).toBe("completed");
    expect(r.summary?.ai).toBe("unavailable");
    expect(r.summary?.text).toContain("CT-HEAD-01");
    expect(r.aiCalls?.map((c) => c.reason)).toEqual(["timeout", "HTTP 500"]);
  });

  it("a content-filter refusal is a rejected step, and the run still completes", async () => {
    const ai = fakeAi({ patient_facts: new AiError("refused", "content_filter", 400), cds_summary: { summary: "ok" } });
    const r = await runAgent(manifest({ extractAi: true }), snap({ indicationCode: manual("DEMO-A"), clinicalNote: manual(NOTE) }), k, ai);
    expect(r.aiCalls?.[0]).toMatchObject({ status: "rejected", reason: "content_filter" });
    expect(r.outcome).toBe("findings");
  });

  it("a summary with a value not in the findings is rejected", async () => {
    const ai = fakeAi({ cds_summary: { summary: "Protocol CT-HEAD-01; give 100 ml contrast." } });
    const r = await runAgent(manifest(), snap({ hasIndication: manual(true), indicationCode: manual("DEMO-A") }), k, ai);
    expect(r.summary?.ai).toBe("rejected");
    expect(r.aiCalls?.[0].reason).toBe("unsupported_value");
    expect(r.summary?.text).toContain("•");
  });

  it("the budget stops extra calls", async () => {
    const ai = fakeAi({ patient_facts: { values: [] }, cds_summary: { summary: "ok" } });
    const r = await runAgent(manifest({ extractAi: true, maxAiCalls: 1 }), snap({ indicationCode: manual("DEMO-A"), clinicalNote: manual(NOTE) }), k, ai);
    expect(ai.calls).toHaveLength(1);
    expect(r.aiCalls?.map((c) => c.status)).toEqual(["nothing_found", "budget"]);
  });

  it("deterministic synthesis or a halted run makes no AI call; useAi=false keeps release tests reproducible", async () => {
    const ai = fakeAi({ cds_summary: { summary: "ok" } });
    await runAgent(manifest({ synthAi: false }), snap({ indicationCode: manual("DEMO-A") }), k, ai);
    await runAgent(manifest(), snap({}), k, ai); // halts at the decision
    const off = await runAgent(manifest({ extractAi: true }), snap({ indicationCode: manual("DEMO-A"), clinicalNote: manual(NOTE) }), k, ai, { useAi: false });
    expect(ai.calls).toHaveLength(0);
    expect(off.aiCalls).toBeUndefined();
    expect(off.summary?.ai).toBe("not_configured");
  });

  it("synthesis gets every finding of the result, even outside the step's own categories", async () => {
    const ai = fakeAi({ cds_summary: { summary: "ok" } });
    const m = manifest();
    for (const n of m.nodes as { type: string; outputCategories: string[] }[]) if (n.type === "final_synthesis") n.outputCategories = ["safety_flag"];
    const r = await runAgent(m, snap({ indicationCode: manual("DEMO-A") }), k, ai);
    expect(r.findings.length).toBeGreaterThan(0);
    expect(JSON.parse(ai.calls[0].input).findings).toHaveLength(r.findings.length);
  });

  it("synthesis gets the findings, the platform rules and denied categories", async () => {
    const ai = fakeAi({ cds_summary: { summary: "ok" } });
    await runAgent(manifest({ denied: "dose_suggestion" }), snap({ indicationCode: manual("DEMO-A") }), k, ai);
    expect(ai.calls[0].instructions).toContain("dose_suggestion");
    expect(ai.calls[0].instructions).toContain("Invent missing facts");
    expect(ai.calls[0].instructions).toContain("Two sentences for the radiologist.");
    expect(JSON.parse(ai.calls[0].input).findings[0].sources).toEqual([{ name: "CT 01 protocols", sheet: "Protocols", row: 8 }]);
  });

  it("the 30 s active budget: no summary call when too little time is left; each call gets the remaining time", async () => {
    const ai = fakeAi({ patient_facts: { values: [] }, cds_summary: { summary: "ok" } });
    const r = await runAgent(manifest({ extractAi: true }), snap({ indicationCode: manual("DEMO-A"), clinicalNote: manual(NOTE) }), k, ai, { activeBudgetMs: 2000 });
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0].timeoutMs).toBeLessThanOrEqual(1000);
    expect(r.aiCalls?.[1]).toMatchObject({ status: "budget", reason: "time" });
  });

  it("a version runs AI only with the model it was frozen with", async () => {
    const ai = fakeAi({ patient_facts: { values: [] }, cds_summary: { summary: "ok" } });
    const pinned = (deployment: string | null) => ({ ...manifest({ extractAi: true }), aiModel: deployment ? { provider: "azure-openai-v1", deployment } : null }) as unknown as Manifest;
    const facts = snap({ indicationCode: manual("DEMO-A"), clinicalNote: manual(NOTE) });
    const other = await runAgent(pinned("gpt-old"), facts, k, ai);
    expect(ai.calls).toHaveLength(0);
    expect(other.aiCalls?.map((c) => c.status)).toEqual(["model_changed", "model_changed"]);
    expect(other.summary?.ai).toBe("model_changed");
    expect(other.outcome).toBe("findings");
    const none = await runAgent(pinned(null), facts, k, ai); // frozen while AI wasn't set up
    expect(none.aiCalls?.[0].status).toBe("model_changed");
    await runAgent(pinned("fake-model"), facts, k, ai);
    expect(ai.calls).toHaveLength(2);
  });

  it("a synthesis step without prompt text (Prompt Builder link only) isn't sent", async () => {
    const ai = fakeAi({ cds_summary: { summary: "ok" } });
    const r = await runAgent(manifest({ synthPrompt: null }), snap({ indicationCode: manual("DEMO-A") }), k, ai);
    expect(ai.calls).toHaveLength(0);
    expect(r.aiCalls?.[0].status).toBe("prompt_unavailable");
  });
});

describe("AI client", () => {
  const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("posts to /responses with the api-key header and a strict schema; parses the message text", async () => {
    const fetchImpl = vi.fn(async () =>
      ok({ model: "gpt-6.1-sol", status: "completed", output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text: '{"summary":"hi"}' }] }], usage: { input_tokens: 12, output_tokens: 3 } }),
    );
    const c = createAiClient({ endpoint: "https://x.example/openai/v1/", apiKey: "k", deployment: "dep", fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await c.call({ instructions: "i", input: "{}", schemaName: "s", schema: { type: "object" } });
    expect(r).toMatchObject({ json: { summary: "hi" }, model: "gpt-6.1-sol", inputTokens: 12, outputTokens: 3 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://x.example/openai/v1/responses");
    expect((init.headers as Record<string, string>)["api-key"]).toBe("k");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: "dep", store: false, text: { format: { type: "json_schema", strict: true, name: "s" } } });
  });

  it("maps HTTP errors, refusals, incomplete replies and bad JSON to AiError", async () => {
    const mk = (res: Response) => createAiClient({ endpoint: "https://x", apiKey: "k", deployment: "d", fetchImpl: (async () => res) as unknown as typeof fetch });
    const call = (c: AiClient) => c.call({ instructions: "", input: "", schemaName: "s", schema: {} });
    await expect(call(mk(ok({ error: { code: "DeploymentNotFound", message: "nope" } }, 404)))).rejects.toMatchObject({ reason: "http", status: 404, message: "HTTP 404 DeploymentNotFound" });
    await expect(call(mk(ok({ error: { code: "content_filter", message: "filtered" } }, 400)))).rejects.toMatchObject({ reason: "refused", message: "content_filter" });
    await expect(call(mk(ok({ output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] })))).rejects.toMatchObject({ reason: "refused" });
    await expect(call(mk(ok({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } })))).rejects.toMatchObject({ reason: "incomplete" });
    await expect(call(mk(ok({ output_text: "not json" })))).rejects.toMatchObject({ reason: "bad_reply" });
    expect(() => outputText({ output: [] })).toThrow(AiError);
  });

  it("times out", async () => {
    const slow = (async (_u: string, init: RequestInit) =>
      new Promise((_r, rej) => init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("t"), { name: "TimeoutError" }))))) as unknown as typeof fetch;
    const c = createAiClient({ endpoint: "https://x", apiKey: "k", deployment: "d", timeoutMs: 20, fetchImpl: slow });
    await expect(c.call({ instructions: "", input: "", schemaName: "s", schema: {} })).rejects.toMatchObject({ reason: "timeout" });
  });
});
