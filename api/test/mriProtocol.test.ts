/**
 * MRI protocol workflow (Medilis handoff, 22 Nov 2026), Phase 1 of the test
 * plan: parser checks with a fake model. Clinical quality is reviewed with the
 * real model and the clinical team, not here.
 */
import { describe, expect, it } from "vitest";
import { AiError, type AiCallInput, type AiClient } from "../src/runtime/aiClient.js";
import { runAgent } from "../src/runtime/aiSteps.js";
import type { InputSnapshot, KnowledgeBinding, KnowledgeRow, Manifest } from "../src/runtime/engine.js";
import { anatomyList, candidateRows, parseAnatomy, parseSelection } from "../src/runtime/protocolAi.js";
import { compile, type AgentGraph, type CompileContext } from "../src/agents/compiler.js";
import { DEFAULT_ANATOMY_PROMPT, DEFAULT_SELECTION_PROMPT } from "../src/runtime/mriPrompts.js";

const SHOULDER = "כתף - מערכת השלד והשרירים";
const SHOULDER_NEURO = "כתף - מערכת העצבים";
const HEART_PED = "לב - מערכת הלב וכלי הדם - ילדים";
const TAKAYASU = "בטן וחזה - מערכת כלי הדם";

let n = 1;
const row = (anatomy: string, code: number, name: string, contrast = "no", tesla = "1.5>3"): KnowledgeRow => {
  n += 1;
  return {
    rowId: `Protocols!${n}`,
    sheet: "Protocols",
    originalRow: n,
    mapped: { anatomy, protocolCode: String(code), protocolName: name },
    hasErrors: false,
    cells: { domain: "MSK MRI", anathomy: anatomy, protocol_number: String(code), protocol_name: name, contrast, Tesla: tesla },
  };
};

const table: KnowledgeBinding = {
  revisionId: "rev-mri",
  sourceName: "MRI protocols V2",
  kind: "device_protocol",
  status: "approved",
  rows: [
    row(SHOULDER, 310, "Shoulder MRI - Standard"),
    row(SHOULDER, 311, "Shoulder MRI - Space Occupying Lesion SOL", "yes"),
    row(SHOULDER, 313, "Shoulder MRI - PostOperative"),
    row(SHOULDER_NEURO, 900, "Shoulder MRI - Standard"), // same name, other anatomy
    row(HEART_PED, 700, "Pediatric Heart MRI"),
    row(TAKAYASU, 800, "Chest and Abdomen MRI - Takayasu Arteritis"),
    row(TAKAYASU, 801, "Chest and Abdomen MRI - Takayasu Arteritis"), // repeated name within the anatomy
  ],
};
const k = new Map([["rev-mri", table]]);

function manifest(opts: { maxAiCalls?: number; aiModel?: string | null } = {}): Manifest {
  return {
    agentId: "mri",
    executionMode: "standalone_cds",
    scope: {},
    agentPrompt: { draftText: "Select an MRI protocol from a referral." },
    budget: { maxAiCalls: opts.maxAiCalls ?? 2 },
    ...(opts.aiModel !== undefined ? { aiModel: opts.aiModel ? { provider: "azure", deployment: opts.aiModel } : null } : {}),
    nodes: [
      { id: "start", type: "start", label: "Referral", executionKind: "deterministic", condition: null, knowledgeRevisionId: null, outputCategories: [] },
      { id: "anat", type: "anatomy_detection", label: "Anatomy", executionKind: "ai", prompt: { draftText: DEFAULT_ANATOMY_PROMPT }, condition: null, knowledgeRevisionId: "rev-mri", outputCategories: [] },
      { id: "sel", type: "protocol_selection", label: "Protocol", executionKind: "ai", prompt: { draftText: DEFAULT_SELECTION_PROMPT }, condition: null, knowledgeRevisionId: "rev-mri", outputCategories: [] },
      { id: "final", type: "final_synthesis", label: "Summary", executionKind: "deterministic", prompt: { draftText: "List the findings." }, condition: null, knowledgeRevisionId: null, outputCategories: ["protocol_match", "missing_data_notice"] },
    ],
    edges: [
      { id: "e1", from: "start", port: "out", to: "anat" },
      { id: "e2", from: "anat", port: "out", to: "sel" },
      { id: "e3", from: "sel", port: "out", to: "final" },
    ],
    effectivePolicy: { rules: [] },
  } as unknown as Manifest;
}

const manual = (value: unknown) => ({ value, status: "present" as const, sourceRef: "manual", observedAt: "2026-11-25T08:00:00Z", attribution: { kind: "manual" as const, userId: "u1" } });
const snap = (facts: InputSnapshot["facts"]): InputSnapshot => ({ caseRef: "MRI-1", requestedAt: "2026-11-25T08:00:00Z", facts });
const BASELINE = "MRI shoulder requested for persistent shoulder pain. No previous surgery. Please assess the rotator cuff.";

/** The list part of the instructions (the prompt's own examples mention other anatomies). */
const listOf = (c: AiCallInput) => c.instructions.slice(c.instructions.lastIndexOf("LIST ("));

function fakeAi(answers: Record<string, string | Error>): AiClient & { calls: AiCallInput[] } {
  const calls: AiCallInput[] = [];
  return {
    model: "fake-model",
    calls,
    async call(req) {
      calls.push(req);
      const a = answers[req.schemaName];
      if (a instanceof Error) throw a;
      return { json: { answer: a }, model: "fake-model", ms: 5, inputTokens: 10, outputTokens: 5 };
    },
  };
}

describe("parsers (service contracts)", () => {
  it("anatomy: exact list value in braces, trimmed and case-insensitive; never a similar value", () => {
    const list = anatomyList(table, false);
    expect(parseAnatomy(`{ ${SHOULDER} }`, list)).toEqual({ status: "used", anatomy: SHOULDER });
    expect(parseAnatomy("{unknown}", list)).toEqual({ status: "unknown" });
    expect(parseAnatomy("{כתף}", list)).toEqual({ status: "invalid" }); // suffix stripped: not in the list
    expect(parseAnatomy("{Knee}", list)).toEqual({ status: "invalid" });
  });

  it("pediatric routing: the pediatric case gets only 'ילדים' values, the adult case none of them", () => {
    expect(anatomyList(table, true)).toEqual([HEART_PED]);
    expect(anatomyList(table, false)).toEqual([SHOULDER, SHOULDER_NEURO, TAKAYASU]);
  });

  it("selection: split once at '|', exact name within the anatomy's rows only", () => {
    const c = candidateRows(table, SHOULDER);
    expect(c.map((r) => r.mapped.protocolCode)).toEqual(["310", "311", "313"]);
    const ok = parseSelection("הסבר קצר.\n|{Shoulder MRI - Standard}", c);
    expect(ok).toMatchObject({ status: "used", name: "Shoulder MRI - Standard", explanation: "הסבר קצר." });
    expect(ok.rowIds).toHaveLength(1); // not the same name under "כתף - מערכת העצבים"
    expect(parseSelection("הסבר |Knee MRI - Standard", c).status).toBe("invalid"); // outside the candidates
    expect(parseSelection("הסבר בלי שם", c).status).toBe("invalid"); // no pipe
    expect(parseSelection("הסבר |{Shoulder MRI - Standard};{Shoulder MRI - PostOperative}", c).status).toBe("two_names");
  });
});

describe("runs", () => {
  it("text baseline: anatomy from the list, one protocol of that anatomy, explanation and row details", async () => {
    const ai = fakeAi({ anatomy: `{${SHOULDER}}`, protocol_selection: "כאב כתף ממושך ללא ניתוח קודם; פרוטוקול סטנדרטי מתאים.\n|Shoulder MRI - Standard" });
    const r = await runAgent(manifest(), snap({ clinicalNote: manual(BASELINE) }), k, ai);
    expect(r.outcome).toBe("findings");
    const f = r.findings.find((x) => x.code === "PROTOCOL_SELECTED")!;
    expect(f.title).toBe("Review selected protocol 310");
    expect(f.detail).toContain("פרוטוקול סטנדרטי");
    expect(f.evidence.map((e) => e.sourceRow)).toHaveLength(1);
    expect(f.details).toEqual(expect.arrayContaining([{ label: "contrast", value: "no" }, { label: "Tesla", value: "1.5>3" }, { label: "protocol_number", value: "310" }]));
    expect(f.observedInputs[0]).toMatchObject({ field: "anatomy", value: SHOULDER, attribution: "ai" });
    // The model got the referral as data, the adult anatomy list, then only the shoulder protocols.
    expect(ai.calls).toHaveLength(2);
    expect(JSON.parse(ai.calls[0].input).referral_text).toBe(BASELINE);
    expect(listOf(ai.calls[0])).toContain(SHOULDER);
    expect(listOf(ai.calls[0])).not.toContain(HEART_PED);
    expect(listOf(ai.calls[1])).toContain("Shoulder MRI - PostOperative");
    expect(listOf(ai.calls[1])).not.toContain("Takayasu");
    expect(ai.calls.map((c) => c.input).join(" ")).not.toContain("MRI-1"); // no case reference sent
    // Raw answers kept on the steps for evaluation; call records without clinical text.
    expect(r.trace.find((t) => t.nodeId === "anat")?.ai).toEqual({ status: "used", answer: `{${SHOULDER}}` });
    expect(r.trace.find((t) => t.nodeId === "sel")?.ai?.answer).toContain("|Shoulder MRI - Standard");
    expect(r.aiCalls?.map((c) => [c.purpose, c.status])).toEqual([["anatomy", "used"], ["selection", "used"]]);
  });

  it("pediatric case (entered flag) gets the pediatric list", async () => {
    const ai = fakeAi({ anatomy: `{${HEART_PED}}`, protocol_selection: "בדיקת לב לילד.|Pediatric Heart MRI" });
    const r = await runAgent(manifest(), snap({ clinicalNote: manual("בדיקת לב לתינוק"), pediatric: manual(true) }), k, ai);
    expect(listOf(ai.calls[0])).toContain(HEART_PED);
    expect(listOf(ai.calls[0])).not.toContain(SHOULDER);
    expect(r.findings[0]).toMatchObject({ code: "PROTOCOL_SELECTED", title: "Review selected protocol 700" });
    expect(r.trace.find((t) => t.nodeId === "anat")?.outputs.pediatric).toBe(true);
  });

  it("age under 18 also routes to the pediatric list", async () => {
    const ai = fakeAi({ anatomy: "{unknown}", protocol_selection: "" });
    await runAgent(manifest(), snap({ clinicalNote: manual("כאב בטן בילד"), ageYears: manual(9) }), k, ai);
    expect(listOf(ai.calls[0])).toContain(HEART_PED);
    expect(listOf(ai.calls[0])).not.toContain(SHOULDER);
  });

  it("unknown anatomy: unresolved, no selection call, no protocol", async () => {
    const ai = fakeAi({ anatomy: "{unknown}" });
    const r = await runAgent(manifest(), snap({ clinicalNote: manual("סרטן גרורתי ללא אזור ספציפי") }), k, ai);
    expect(r.outcome).toBe("needs_review");
    expect(r.findings.map((f) => f.code)).toEqual(["ANATOMY_UNRESOLVED"]);
    expect(ai.calls).toHaveLength(1);
    expect(r.trace.find((t) => t.nodeId === "sel")).toMatchObject({ state: "completed", note: expect.stringContaining("No anatomy") });
  });

  it("anatomy outside the list (suffix stripped) is rejected, not corrected", async () => {
    const ai = fakeAi({ anatomy: "{כתף}" });
    const r = await runAgent(manifest(), snap({ clinicalNote: manual(BASELINE) }), k, ai);
    expect(r.findings.map((f) => f.code)).toEqual(["ANATOMY_UNRESOLVED"]);
    expect(r.trace.find((t) => t.nodeId === "anat")?.ai?.status).toBe("invalid");
  });

  it("invalid name and two names: unresolved, never a guessed protocol", async () => {
    for (const answer of ["הסבר |{Knee MRI - Standard}", "הסבר |{Shoulder MRI - Standard};{Shoulder MRI - PostOperative}"]) {
      const ai = fakeAi({ anatomy: `{${SHOULDER}}`, protocol_selection: answer });
      const r = await runAgent(manifest(), snap({ clinicalNote: manual(BASELINE) }), k, ai);
      expect(r.outcome).toBe("needs_review");
      expect(r.findings.map((f) => f.code)).toEqual(["PROTOCOL_UNRESOLVED"]);
      expect(r.findings[0].evidence).toEqual([]);
    }
  });

  it("a name that repeats within the anatomy is shown as a conflict with both rows", async () => {
    const ai = fakeAi({ anatomy: `{${TAKAYASU}}`, protocol_selection: "חשד לטקיאסו.|Chest and Abdomen MRI - Takayasu Arteritis" });
    const r = await runAgent(manifest(), snap({ clinicalNote: manual("Takayasu arteritis follow-up") }), k, ai);
    expect(r.findings[0]).toMatchObject({ code: "PROTOCOL_CONFLICT" });
    expect(r.findings[0].evidence).toHaveLength(2);
  });

  it("empty referral (e.g. OCR found nothing): the run asks for the referral text", async () => {
    const ai = fakeAi({});
    const r = await runAgent(manifest(), snap({}), k, ai);
    expect(r.outcome).toBe("needs_input");
    expect(r.missingInputs).toEqual(["clinicalNote"]);
    expect(ai.calls).toHaveLength(0);
  });

  it("AI not available or not configured: unresolved result, the run still completes", async () => {
    const down = fakeAi({ anatomy: new AiError("timeout", "slow") });
    const r1 = await runAgent(manifest(), snap({ clinicalNote: manual(BASELINE) }), k, down);
    expect(r1.outcome).toBe("needs_review");
    expect(r1.trace.find((t) => t.nodeId === "anat")?.ai?.status).toBe("unavailable");
    const r2 = await runAgent(manifest(), snap({ clinicalNote: manual(BASELINE) }), k, null);
    expect(r2.outcome).toBe("needs_review");
    expect(r2.trace.find((t) => t.nodeId === "anat")?.ai?.status).toBe("not_configured");
  });

  it("release tests (deterministic only) don't call the model", async () => {
    const ai = fakeAi({ anatomy: `{${SHOULDER}}` });
    const r = await runAgent(manifest(), snap({ clinicalNote: manual(BASELINE) }), k, ai, { useAi: false });
    expect(ai.calls).toHaveLength(0);
    expect(r.trace.find((t) => t.nodeId === "anat")?.ai?.status).toBe("not_run");
  });

  it("a version approved with another model doesn't call this one", async () => {
    const ai = fakeAi({ anatomy: `{${SHOULDER}}` });
    const r = await runAgent(manifest({ aiModel: "older-model" }), snap({ clinicalNote: manual(BASELINE) }), k, ai);
    expect(ai.calls).toHaveLength(0);
    expect(r.trace.find((t) => t.nodeId === "anat")?.ai?.status).toBe("model_changed");
  });

  it("a withdrawn table blocks the run", async () => {
    const r = await runAgent(manifest(), snap({ clinicalNote: manual(BASELINE) }), new Map([["rev-mri", { ...table, status: "withdrawn" }]]), fakeAi({}));
    expect(r.outcome).toBe("blocked");
  });
});

describe("compiler", () => {
  const ctx: CompileContext = {
    agentId: "mri",
    kind: "cds",
    scope: {},
    executionMode: "standalone_cds",
    agentPrompt: { draftText: "Select an MRI protocol." },
    prohibitions: { optional: [], custom: [] },
    knowledge: new Map([["rev-mri", { status: "approved", kind: "device_protocol" }], ["rev-other", { status: "approved", kind: "device_protocol" }]]),
    clinicProfiles: new Map(),
    aiModel: { provider: "azure", deployment: "m" },
  };
  const graph = (over: Partial<Record<"anat" | "sel", Record<string, unknown>>> = {}, withAnat = true): AgentGraph => ({
    nodes: [
      { id: "start", type: "start", label: "Referral" },
      ...(withAnat ? [{ id: "anat", type: "anatomy_detection", label: "Anatomy", executionKind: "ai" as const, knowledgeRevisionId: "rev-mri", ...over.anat }] : []),
      { id: "sel", type: "protocol_selection", label: "Protocol", executionKind: "ai" as const, knowledgeRevisionId: "rev-mri", ...over.sel },
      { id: "final", type: "final_synthesis", label: "Summary", prompt: { draftText: "List the findings." }, outputCategories: ["protocol_match"] },
    ],
    edges: [
      { id: "e1", from: "start", port: "out", to: withAnat ? "anat" : "sel" },
      ...(withAnat ? [{ id: "e2", from: "anat", port: "out", to: "sel" }] : []),
      { id: "e3", from: "sel", port: "out", to: "final" },
    ],
  });

  it("compiles, and an empty prompt freezes the built-in V2 prompt", () => {
    const r = compile(graph(), ctx);
    expect(r.issues).toEqual([]);
    const nodes = (r.manifest as { nodes: { id: string; prompt: { draftText: string } }[] }).nodes;
    expect(nodes.find((x) => x.id === "anat")?.prompt.draftText).toBe(DEFAULT_ANATOMY_PROMPT);
    expect(nodes.find((x) => x.id === "sel")?.prompt.draftText).toBe(DEFAULT_SELECTION_PROMPT);
    expect(DEFAULT_ANATOMY_PROMPT.startsWith("You are a medical imaging triage assistant.")).toBe(true);
    expect(DEFAULT_SELECTION_PROMPT).not.toMatch(/second|two protocols|;\{/i);
  });

  it("requires AI mode, an anatomy step before selection, and the same table", () => {
    expect(compile(graph({ sel: { executionKind: "deterministic" } }), ctx).issues.map((i) => i.code)).toContain("ai_required");
    expect(compile(graph({}, false), ctx).issues.map((i) => i.code)).toContain("anatomy_required");
    expect(compile(graph({ sel: { knowledgeRevisionId: "rev-other" } }), ctx).issues.map((i) => i.code)).toContain("anatomy_knowledge");
  });
});

describe("the Medilis V2 protocol table (assets/mri)", () => {
  it("imports as is: 254 rows, 80 anatomy values, no problems, Hebrew and suffixes kept", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { checkXlsxPackage, readXlsxSheet } = await import("../src/knowledge/spreadsheet.js");
    const { normalizeRows } = await import("../src/knowledge/normalize.js");
    const buf = fs.readFileSync(path.resolve(__dirname, "../../assets/mri/protocolsnewlastversion.xlsx"));
    await checkXlsxPackage(buf);
    const sheet = await readXlsxSheet(buf, "Protocols");
    const out = normalizeRows(sheet, { headerRow: 1, mapping: { anathomy: "anatomy", protocol_number: "protocolCode", protocol_name: "protocolName" }, kind: "device_protocol" });
    expect(out.headers).toEqual(["domain", "anathomy", "protocol_number", "protocol_name", "contrast", "Tesla"]);
    expect(out.rows).toHaveLength(254);
    expect(out.errorCount).toBe(0);
    const binding: KnowledgeBinding = {
      revisionId: "v2",
      sourceName: "V2",
      kind: "device_protocol",
      status: "approved",
      rows: out.rows.map((r) => ({ rowId: r.rowId, sheet: "Protocols", originalRow: r.originalRow, mapped: r.mapped, hasErrors: r.errors.length > 0 })),
    };
    const adult = anatomyList(binding, false);
    const ped = anatomyList(binding, true);
    expect(adult.length + ped.length).toBe(80);
    expect(adult).toContain(SHOULDER);
    expect(ped).toContain(HEART_PED);
    expect(candidateRows(binding, SHOULDER).map((r) => r.mapped.protocolName)).toContain("Shoulder MRI - Standard");
  });
});
