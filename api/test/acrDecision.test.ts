/**
 * ACR-based decision support (Medilis handoff, 22 Nov 2026), Phase 2 of the
 * test plan: routing and parser checks with a fake model, and the supplied
 * catalogues imported as one table. Clinical quality is reviewed with the
 * real model and the clinical team, not here.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type AiCallInput, type AiClient } from "../src/runtime/aiClient.js";
import { runAgent } from "../src/runtime/aiSteps.js";
import type { InputSnapshot, KnowledgeBinding, KnowledgeRow, Manifest } from "../src/runtime/engine.js";
import {
  DEFAULT_ACR_RULES_PROMPT_CT,
  DEFAULT_ACR_RULES_PROMPT_MRI,
  DEFAULT_ACR_TOPIC_PROMPT,
  candidateRules,
  parseRules,
  parseTopic,
  referralContext,
  rulesJson,
  topicCatalogue,
} from "../src/runtime/acrAi.js";
import { compile, type AgentGraph, type CompileContext } from "../src/agents/compiler.js";
import { inputFieldsOf } from "../src/agents/service.js";
import { ACR_MAPPING, ACR_SHEET, buildAcrTable } from "../src/knowledge/acrTable.js";

const H = {
  id: "Rule ID",
  topic: "ACR Topic",
  variant: "ACR Variant / מצב קליני",
  requested: "בדיקה שהתבקשה",
  recommended: "בדיקה מומלצת לפי ACR",
  contrast: "חומר ניגוד",
  decision: "החלטת מערכת",
  modality: "Modality",
};
const FACIAL = "Facial Pain  or  Headache"; // doubled spaces, as in the CT table

let n = 1;
const rule = (id: string, modality: "CT" | "MRI", topic: string, variant: string, recommended: string, decision = "Review"): KnowledgeRow => {
  n += 1;
  return {
    rowId: id,
    sheet: ACR_SHEET,
    originalRow: n,
    mapped: { rowId: id, topic, indication: variant, result: recommended, modality },
    hasErrors: false,
    cells: { [H.id]: id, [H.topic]: topic, [H.variant]: variant, [H.requested]: `${modality} Head WO`, [H.recommended]: recommended, [H.contrast]: "ללא", [H.decision]: decision, [H.modality]: modality },
  };
};

const table: KnowledgeBinding = {
  revisionId: "rev-acr",
  sourceName: "ACR rules CT + MRI",
  kind: "clinical_rule",
  status: "approved",
  rows: [
    rule("CT_HEAD_001", "CT", "Headache", "כאב ראש רגיל / מיגרנה יציבה, ללא red flags", "No imaging", "Suggest no imaging"),
    rule("CT_HEAD_002", "CT", "Headache", "כאב ראש פתאומי חמור", "CT Head WO", "Approve"),
    rule("CT_HEAD_003", "CT", "Headache", "כאב ראש עם חסר נוירולוגי", "MRI Brain W/WO"),
    rule("CT_FACE_001", "CT", FACIAL, "כאב פנים", "CT Sinus WO"),
    rule("CT_TRAUMA_001", "CT", "Head Trauma", "חבלת ראש", "CT Head WO"), // another topic: never sent with Headache
    rule("MRI_SHOULDER_001", "MRI", "Acute Shoulder Pain", "כאב כתף חריף, ללא צילום קודם", "X-ray Shoulder", "Suggest X-ray first"),
    rule("MRI_SHOULDER_002", "MRI", "Acute Shoulder Pain", "כאב כתף חריף, צילום תקין", "MRI Shoulder WO", "Approve"),
    rule("MRI_HEAD_001", "MRI", "Headache", "כאב ראש עם red flags", "MRI Brain W/WO"),
    rule("MRI_PROSTATE_001", "MRI", "Prostate Cancer", "PSA מוגבר", "MRI Prostate W/WO"), // only in the MRI catalogue
  ],
};
const k = new Map([["rev-acr", table]]);

function manifest(opts: { rulesPrompt?: string | null; maxAiCalls?: number } = {}): Manifest {
  return {
    agentId: "acr",
    executionMode: "standalone_cds",
    scope: {},
    agentPrompt: { draftText: "Match the referral to the ACR-based catalogue." },
    budget: { maxAiCalls: opts.maxAiCalls ?? 2 },
    nodes: [
      { id: "start", type: "start", label: "Referral", executionKind: "deterministic", condition: null, knowledgeRevisionId: null, outputCategories: [] },
      { id: "topic", type: "acr_topic_detection", label: "ACR topic", executionKind: "ai", prompt: { draftText: DEFAULT_ACR_TOPIC_PROMPT }, condition: null, knowledgeRevisionId: "rev-acr", outputCategories: [] },
      {
        id: "rules",
        type: "acr_rule_selection",
        label: "ACR rules",
        executionKind: "ai",
        prompt: opts.rulesPrompt ? { draftText: opts.rulesPrompt } : null,
        ...(opts.rulesPrompt ? {} : { builtinPrompts: { ct: DEFAULT_ACR_RULES_PROMPT_CT, mri: DEFAULT_ACR_RULES_PROMPT_MRI } }),
        condition: null,
        knowledgeRevisionId: "rev-acr",
        outputCategories: [],
      },
      { id: "final", type: "final_synthesis", label: "Summary", executionKind: "deterministic", prompt: { draftText: "List the findings." }, condition: null, knowledgeRevisionId: null, outputCategories: ["appropriateness_finding", "missing_data_notice"] },
    ],
    edges: [
      { id: "e1", from: "start", port: "out", to: "topic" },
      { id: "e2", from: "topic", port: "out", to: "rules" },
      { id: "e3", from: "rules", port: "out", to: "final" },
    ],
    effectivePolicy: { rules: [] },
  } as unknown as Manifest;
}

const manual = (value: unknown) => ({ value, status: "present" as const, sourceRef: "manual", observedAt: "2026-11-26T08:00:00Z", attribution: { kind: "manual" as const, userId: "u1" } });
const snap = (facts: InputSnapshot["facts"]): InputSnapshot => ({ caseRef: "ACR-1", requestedAt: "2026-11-26T08:00:00Z", facts });
const CT_HEAD = "CT head without contrast requested for stable longstanding migraine. No new symptoms or red flags.";
const MRI_SHOULDER = "MRI shoulder without contrast requested for acute shoulder pain. No previous shoulder radiograph.";

function fakeAi(answers: Record<string, string>): AiClient & { calls: AiCallInput[] } {
  const calls: AiCallInput[] = [];
  return {
    model: "fake-model",
    calls,
    async call(req) {
      calls.push(req);
      return { json: { answer: answers[req.schemaName] }, model: "fake-model", ms: 5, inputTokens: 10, outputTokens: 5 };
    },
  };
}

/** The rules the selection call was given (the rulesJson bound into the prompt). */
function sentRules(c: AiCallInput): string[] {
  return [...c.instructions.matchAll(/"rule_id":"([^"]+)"/g)].map((m) => m[1]);
}

describe("parsers (handoff steps 3 and 6)", () => {
  const cat = topicCatalogue(table);

  it("topic: exactly two fields, braces optional, topic from that modality's catalogue", () => {
    expect(parseTopic("{Headache}|{ct}", cat)).toEqual({ status: "used", topic: "Headache", modality: "ct" });
    expect(parseTopic(" headache | MRI ", cat)).toEqual({ status: "used", topic: "Headache", modality: "mri" });
    expect(parseTopic("{unknown}|{other}", cat)).toEqual({ status: "unknown", modality: "other" });
    expect(parseTopic("{unknown}", cat)).toEqual({ status: "unknown", modality: "other" });
    expect(parseTopic("{Headache}|{other}", cat)).toEqual({ status: "unsupported", modality: "other" });
    expect(parseTopic("{Headache}|{us}", cat)).toMatchObject({ status: "invalid", reason: "modality" });
    expect(parseTopic("Headache", cat)).toMatchObject({ status: "invalid", reason: "format" });
    expect(parseTopic("{Headache}|{ct}|{x}", cat)).toMatchObject({ status: "invalid", reason: "format" });
    expect(parseTopic("{Prostate Cancer}|{ct}", cat)).toMatchObject({ status: "invalid", reason: "topic_not_in_modality" });
    expect(parseTopic("{Migraine}|{ct}", cat)).toMatchObject({ status: "invalid", reason: "topic_not_in_list" });
  });

  it("topic spacing: the table value is kept exactly; a reply differing only in spacing finds it", () => {
    expect(cat.topics).toContain(FACIAL);
    expect(parseTopic(`{${FACIAL}}|{ct}`, cat)).toEqual({ status: "used", topic: FACIAL, modality: "ct" });
    expect(parseTopic("{Facial Pain or Headache}|{ct}", cat)).toEqual({ status: "used", topic: FACIAL, modality: "ct" });
    expect(candidateRules(table, "ct", FACIAL).map((r) => r.rowId)).toEqual(["CT_FACE_001"]);
  });

  it("rules: ruleId|rank|explanation, candidate ids only, one rank 1, sorted by rank", () => {
    const c = candidateRules(table, "ct", "Headache");
    expect(c.map((r) => r.rowId)).toEqual(["CT_HEAD_001", "CT_HEAD_002", "CT_HEAD_003"]);
    const ok = parseRules("CT_HEAD_003|2|חסר נוירולוגי\nCT_HEAD_001|1|מיגרנה יציבה ללא סימני אזהרה\n", c);
    expect(ok).toEqual({
      status: "used",
      selected: [
        { rowId: "CT_HEAD_001", rank: 1, explanation: "מיגרנה יציבה ללא סימני אזהרה" },
        { rowId: "CT_HEAD_003", rank: 2, explanation: "חסר נוירולוגי" },
      ],
    });
    expect(parseRules("CT_HEAD_001|1|הסבר", c).selected).toHaveLength(1); // sparse is fine
    expect(parseRules("CT_TRAUMA_001|1|הסבר", c)).toMatchObject({ status: "invalid", reason: "unknown_rule" }); // other topic
    expect(parseRules("CT_HEAD_001|1|הסבר|עוד", c)).toMatchObject({ status: "invalid", reason: "bad_line" });
    expect(parseRules("CT_HEAD_001||הסבר", c)).toMatchObject({ status: "invalid", reason: "bad_rank" });
    expect(parseRules("CT_HEAD_001|0|הסבר", c)).toMatchObject({ status: "invalid", reason: "bad_rank" });
    expect(parseRules("CT_HEAD_001|1|א\nCT_HEAD_002|1|ב", c)).toMatchObject({ status: "invalid", reason: "rank1" });
    expect(parseRules("CT_HEAD_001|2|א\nCT_HEAD_002|3|ב", c)).toMatchObject({ status: "invalid", reason: "rank1" });
    expect(parseRules("CT_HEAD_001|1|א\nCT_HEAD_001|2|ב", c)).toMatchObject({ status: "invalid", reason: "duplicate_rule" });
    expect(parseRules("CT_HEAD_001|1|א\nהסבר נוסף", c)).toMatchObject({ status: "invalid", reason: "bad_line" });
  });

  it("rulesJson: the service's field names, topic and modality left out, empty cells as empty text", () => {
    const [r] = rulesJson(candidateRules(table, "mri", "Acute Shoulder Pain"));
    expect(r).toMatchObject({ rule_id: "MRI_SHOULDER_001", acr_variant: "כאב כתף חריף, ללא צילום קודם", recommended_exam: "X-ray Shoulder", system_decision: "Suggest X-ray first", alternative_exam: "" });
    expect(r).not.toHaveProperty("acr_topic");
    expect(Object.keys(r)).not.toContain("Modality");
  });

  it("referral context: every category with text, under its name, in CRE's order", () => {
    const ctx = referralContext({ clinicalNote: manual("הפניה"), labs: manual("CRP 80"), diagnoses: { status: "missing" }, priors: manual("CT 2025: תקין") });
    expect(ctx).toBe("Referral:\nהפניה\n\nPrior imaging / reports:\nCT 2025: תקין\n\nLaboratory results:\nCRP 80");
  });
});

describe("runs", () => {
  it("CT routing: topic from the union list, only that topic's CT rules, ranked rules joined to the table", async () => {
    const ai = fakeAi({ acr_topic: "{Headache}|{ct}", acr_rules: "CT_HEAD_001|1|מיגרנה יציבה ללא red flags\nCT_HEAD_003|2|לשלול חסר נוירולוגי" });
    const r = await runAgent(manifest(), snap({ clinicalNote: manual(CT_HEAD) }), k, ai);

    const [detect, select] = ai.calls;
    // Placeholders bound; the referral is data, not instructions.
    // (The detector's own "{topic}|{test}" answer format stays: it describes the output.)
    expect(detect.instructions).not.toContain("{topicList}");
    expect(detect.instructions).toContain("Answer format: {topic}|{test}");
    expect(select.instructions).not.toMatch(/\{rulesJson\}|\{topic\}|\{referralContext\}/);
    for (const c of ai.calls) {
      expect(c.instructions).not.toContain(CT_HEAD);
      expect(JSON.parse(c.input)).toEqual({ referral_context: `Referral:\n${CT_HEAD}` });
    }
    // Every topic of both catalogues, grouped by catalogue and numbered through (a topic of both is in each group).
    expect(detect.instructions).toContain(`CT catalogue (answer with ct):\n1. Headache\n2. ${FACIAL}\n3. Head Trauma\n\nMRI catalogue (answer with mri):\n4. Acute Shoulder Pain\n5. Headache\n6. Prostate Cancer\n`);
    expect(select.instructions.startsWith("You are an ACR Clinical Decision Support rule-matching engine for CT")).toBe(true);
    expect(select.instructions).toContain('selected CT imaging topic: "Headache"');
    expect(sentRules(select)).toEqual(["CT_HEAD_001", "CT_HEAD_002", "CT_HEAD_003"]); // not MRI_HEAD_001, not other topics

    expect(r.outcome).toBe("findings");
    expect(r.findings.map((f) => [f.code, f.severity])).toEqual([
      ["ACR_RULE_PRIMARY", "review"],
      ["ACR_RULE_RELATED", "info"],
    ]);
    const [primary, related] = r.findings;
    expect(primary.title).toBe("Review ACR rule CT_HEAD_001: No imaging");
    expect(primary.detail).toBe("מיגרנה יציבה ללא red flags");
    expect(primary.details).toContainEqual({ label: H.decision, value: "Suggest no imaging" });
    expect(primary.evidence).toEqual([{ knowledgeRevisionId: "rev-acr", sourceName: "ACR rules CT + MRI", rowId: "CT_HEAD_001", sheet: ACR_SHEET, sourceRow: table.rows[0].originalRow }]);
    expect(related.title).toBe("Related ACR rule CT_HEAD_003 (rank 2)");
    const rules = r.trace.find((t) => t.nodeId === "rules")!;
    expect(rules.outputs).toMatchObject({ matched: true, ruleId: "CT_HEAD_001", recommendedExam: "No imaging", matchCount: 2 });
    // Scope: the rules of this topic only, said on the run.
    expect(rules.ai).toMatchObject({ status: "used", count: 3, topic: "Headache", modality: "ct" });
    expect(rules.ai!.answer).toContain("CT_HEAD_003|2|");
    expect(r.trace.find((t) => t.nodeId === "topic")!.outputs).toEqual({ found: true, topic: "Headache", modality: "ct" });
    expect(r.aiCalls!.map((c) => c.purpose)).toEqual(["acr_topic", "acr_rules"]);
  });

  it("MRI routing: the MRI prompt and the MRI catalogue's rules of the topic", async () => {
    const ai = fakeAi({ acr_topic: "{Acute Shoulder Pain}|{mri}", acr_rules: "MRI_SHOULDER_001|1|ללא צילום קודם: צילום קודם" });
    const r = await runAgent(manifest(), snap({ clinicalNote: manual(MRI_SHOULDER) }), k, ai);
    expect(ai.calls[1].instructions.startsWith("You are an ACR Clinical Decision Support rule-matching engine for MRI")).toBe(true);
    expect(sentRules(ai.calls[1])).toEqual(["MRI_SHOULDER_001", "MRI_SHOULDER_002"]);
    expect(r.findings[0]).toMatchObject({ code: "ACR_RULE_PRIMARY", title: "Review ACR rule MRI_SHOULDER_001: X-ray Shoulder" });
  });

  it("unknown or unsupported modality: no rule-selection call, review", async () => {
    for (const [answer, code] of [
      ["{unknown}|{other}", "ACR_TOPIC_UNRESOLVED"],
      ["{Headache}|{other}", "ACR_MODALITY_UNSUPPORTED"],
      ["{Prostate Cancer}|{ct}", "ACR_TOPIC_UNRESOLVED"],
    ] as const) {
      const ai = fakeAi({ acr_topic: answer });
      const r = await runAgent(manifest(), snap({ clinicalNote: manual("US abdomen for RUQ pain") }), k, ai);
      expect(ai.calls).toHaveLength(1);
      expect(r.outcome).toBe("needs_review");
      expect(r.findings.map((f) => f.code)).toEqual([code]);
      expect(r.trace.find((t) => t.nodeId === "rules")!.note).toBe("No ACR topic was determined, so no rule is selected.");
    }
  });

  it("invalid selection output: nothing partial is shown, the run asks for review", async () => {
    for (const bad of ["CT_HEAD_009|1|לא קיים", "CT_HEAD_001|1|א|ב", "CT_HEAD_001|1|א\nCT_HEAD_002|1|ב", "CT_HEAD_001|x|א"]) {
      const ai = fakeAi({ acr_topic: "{Headache}|{ct}", acr_rules: bad });
      const r = await runAgent(manifest(), snap({ clinicalNote: manual(CT_HEAD) }), k, ai);
      expect(r.findings.map((f) => f.code)).toEqual(["ACR_RULE_UNRESOLVED"]);
      const rules = r.trace.find((t) => t.nodeId === "rules")!;
      expect(rules.ai).toMatchObject({ status: "invalid", answer: bad });
      expect(rules.outputs).toMatchObject({ matched: false, matchCount: 0 });
    }
  });

  it("context merging: priors, labs and diagnoses are sent with the referral; a referral alone is not required", async () => {
    const ai = fakeAi({ acr_topic: "{Headache}|{mri}", acr_rules: "MRI_HEAD_001|1|חסר נוירולוגי חדש" });
    await runAgent(manifest(), snap({ clinicalNote: manual("MRI brain"), diagnoses: manual("Breast cancer 2024"), labs: manual("CRP 80") }), k, ai);
    const ctx = JSON.parse(ai.calls[0].input).referral_context as string;
    expect(ctx).toBe("Referral:\nMRI brain\n\nLaboratory results:\nCRP 80\n\nDiagnoses:\nBreast cancer 2024");
    expect(ai.calls[1].input).toBe(ai.calls[0].input);

    const only = fakeAi({ acr_topic: "{unknown}|{other}" });
    const r = await runAgent(manifest(), snap({ priors: manual("CT head 2025: normal") }), k, only);
    expect(only.calls).toHaveLength(1);
    expect(r.outcome).toBe("needs_review");
  });

  it("no referral text at all: needs input, no AI call", async () => {
    const ai = fakeAi({});
    const r = await runAgent(manifest(), snap({ clinicalNote: { status: "missing" } }), k, ai);
    expect(ai.calls).toHaveLength(0);
    expect(r.outcome).toBe("needs_input");
    expect(r.missingInputs).toEqual(["clinicalNote"]);
  });

  it("an author's selection prompt is used for both modalities; placeholders it lacks are added", async () => {
    const ai = fakeAi({ acr_topic: "{Headache}|{ct}", acr_rules: "CT_HEAD_002|1|פתאומי" });
    await runAgent(manifest({ rulesPrompt: "Pick the best rules. Answer ruleId|rank|explanation." }), snap({ clinicalNote: manual(CT_HEAD) }), k, ai);
    const ins = ai.calls[1].instructions;
    expect(ins.startsWith("Pick the best rules.")).toBe(true);
    expect(ins).toContain('Selected topic: "Headache"');
    expect(sentRules(ai.calls[1])).toEqual(["CT_HEAD_001", "CT_HEAD_002", "CT_HEAD_003"]);
  });

  it("AI off (release tests): no call, unresolved for review", async () => {
    const r = await runAgent(manifest(), snap({ clinicalNote: manual(CT_HEAD) }), k, fakeAi({}), { useAi: false });
    expect(r.findings.map((f) => f.code)).toEqual(["ACR_TOPIC_UNRESOLVED"]);
    expect(r.trace.find((t) => t.nodeId === "topic")!.ai).toMatchObject({ status: "not_run" });
  });
});

describe("authoring", () => {
  const ctx: CompileContext = {
    agentId: "acr",
    kind: "cds",
    scope: {},
    executionMode: "standalone_cds",
    agentPrompt: { draftText: "Match the referral to the ACR catalogue." },
    prohibitions: { optional: [], custom: [] },
    knowledge: new Map([
      ["rev-acr", { status: "approved", kind: "clinical_rule" }],
      ["rev-other", { status: "approved", kind: "clinical_rule" }],
    ]),
    clinicProfiles: new Map(),
    aiModel: { provider: "azure", deployment: "m" },
  };
  const graph = (rulesKnowledge = "rev-acr", withTopic = true): AgentGraph => ({
    nodes: [
      { id: "start", type: "start", label: "Start" },
      ...(withTopic ? [{ id: "topic", type: "acr_topic_detection", label: "Topic", executionKind: "ai" as const, knowledgeRevisionId: "rev-acr" }] : []),
      { id: "rules", type: "acr_rule_selection", label: "Rules", executionKind: "ai" as const, knowledgeRevisionId: rulesKnowledge },
      { id: "final", type: "final_synthesis", label: "Result", executionKind: "deterministic" as const, prompt: { draftText: "List." }, outputCategories: ["appropriateness_finding"] },
    ],
    edges: [
      ...(withTopic
        ? [
            { id: "e1", from: "start", port: "out", to: "topic" },
            { id: "e2", from: "topic", port: "out", to: "rules" },
          ]
        : [{ id: "e1", from: "start", port: "out", to: "rules" }]),
      { id: "e3", from: "rules", port: "out", to: "final" },
    ],
  });

  it("empty prompts: the topic prompt and both CT and MRI selection prompts are frozen with the version", () => {
    const c = compile(graph(), ctx);
    expect(c.ok).toBe(true);
    const nodes = (c.manifest!.nodes as { id: string; prompt: { draftText: string } | null; builtinPrompts?: Record<string, string> }[]);
    const topic = nodes.find((x) => x.id === "topic")!;
    const rules = nodes.find((x) => x.id === "rules")!;
    expect(topic.prompt!.draftText).toBe(DEFAULT_ACR_TOPIC_PROMPT);
    expect(rules.prompt).toBeNull();
    expect(rules.builtinPrompts).toEqual({ ct: DEFAULT_ACR_RULES_PROMPT_CT, mri: DEFAULT_ACR_RULES_PROMPT_MRI });
    expect(nodes.find((x) => x.id === "final")).not.toHaveProperty("builtinPrompts");
  });

  it("rule selection needs a topic detection block before it, on the same table", () => {
    expect(compile(graph("rev-acr", false), ctx).issues.map((i) => i.code)).toContain("acr_topic_required");
    expect(compile(graph("rev-other"), ctx).issues.map((i) => i.code)).toContain("acr_knowledge");
  });

  it("test runs of an ACR version ask for the referral and its other categories only", () => {
    expect(inputFieldsOf({ nodes: [{ type: "start" }, { type: "acr_topic_detection" }, { type: "acr_rule_selection" }, { type: "final_synthesis" }] })).toEqual(["clinicalNote", "priors", "labs", "diagnoses"]);
  });
});

describe("the supplied ACR catalogues (assets/acr) as one table", () => {
  it("CT 860 + MRI 469 unique rules (28 exact orbit duplicates collapsed), imported without problems", async () => {
    const { checkXlsxPackage, readXlsxSheet } = await import("../src/knowledge/spreadsheet.js");
    const { normalizeRows } = await import("../src/knowledge/normalize.js");
    const dir = path.resolve(__dirname, "../../assets/acr");
    const t = await buildAcrTable(fs.readFileSync(path.join(dir, "acr_cds_table__ct.xlsx")), fs.readFileSync(path.join(dir, "acr_cds_table__mri.xlsx")));
    expect(t.counts.map((c) => [c.modality, c.sheet, c.rows, c.unique, c.collapsed.length])).toEqual([
      ["CT", "CT", 860, 860, 0],
      ["MRI", "Sheet1", 497, 469, 28],
    ]);
    expect(t.counts[1].collapsed[0]).toBe("MRI_ORBIT_001");

    await checkXlsxPackage(t.buffer);
    const sheet = await readXlsxSheet(t.buffer, ACR_SHEET);
    const out = normalizeRows(sheet, { headerRow: 1, mapping: ACR_MAPPING, kind: "clinical_rule" });
    expect(out.rows).toHaveLength(1329);
    expect(out.errorCount).toBe(0);
    const binding: KnowledgeBinding = {
      revisionId: "acr",
      sourceName: "ACR",
      kind: "clinical_rule",
      status: "approved",
      rows: out.rows.map((r) => ({
        rowId: r.rowId,
        sheet: ACR_SHEET,
        originalRow: r.originalRow,
        mapped: r.mapped,
        hasErrors: r.errors.length > 0,
        cells: Object.fromEntries(Object.entries(r.cells).map(([h, c]) => [h, String(c.v)])),
      })),
    };
    const cat = topicCatalogue(binding);
    expect(cat.byModality.ct.size).toBe(614);
    expect(cat.byModality.mri.size).toBe(264);
    expect(cat.topics).toContain(FACIAL); // doubled spaces kept
    // The test plan's baseline candidates.
    expect(candidateRules(binding, "ct", "Headache").map((r) => r.rowId)).toContain("CT_HEAD_001");
    expect(candidateRules(binding, "mri", "Acute Shoulder Pain").map((r) => r.rowId)).toContain("MRI_SHOULDER_001");
    const knee = rulesJson(binding.rows.filter((r) => r.rowId === "MRI_KNEE_009"))[0];
    expect(knee).toMatchObject({ recommended_exam: "MRI Knee WO", system_decision: "", contrast_material: "" });
    const [first] = rulesJson(candidateRules(binding, "mri", "Acute Shoulder Pain"));
    expect(first).toEqual({
      rule_id: "MRI_SHOULDER_001",
      acr_variant: "כאב כתף חריף, Initial imaging, ללא צילום קודם",
      requested_exam: "MRI Shoulder WO",
      requested_exam_rating: "Usually Not Appropriate",
      requested_exam_score: "1",
      recommended_exam: "X-ray Shoulder",
      recommended_exam_rating: "Usually Appropriate",
      recommended_exam_score: "9",
      alternative_exam: "—",
      contrast_material: "ללא",
      system_decision: "Suggest X-ray first",
    }); // same as the handoff's JSON export
  });
});
