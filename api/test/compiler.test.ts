import { describe, expect, it } from "vitest";
import { compile, validate, canonicalJson, type AgentGraph, type CompileContext } from "../src/agents/compiler.js";

const K_PROTO = "11111111-1111-1111-1111-111111111111";
const K_RULE = "22222222-2222-2222-2222-222222222222";
const K_DRAFT = "33333333-3333-3333-3333-333333333333";
const K_DOC = "44444444-4444-4444-4444-444444444444";
const PROFILE = "55555555-5555-5555-5555-555555555555";

function ctx(over: Partial<CompileContext> = {}): CompileContext {
  return {
    agentId: "agent-1",
    kind: "cds",
    scope: { facilityId: "site-1", departmentId: "rad", deviceIds: ["CT-01"] },
    executionMode: "standalone_cds",
    agentPrompt: { draftText: "Check CT referrals against the local protocol for clinician review." },
    prohibitions: { optional: [], custom: [] },
    knowledge: new Map([
      [K_PROTO, { status: "approved", kind: "device_protocol" }],
      [K_RULE, { status: "approved", kind: "clinical_rule" }],
      [K_DRAFT, { status: "draft", kind: "device_protocol" }],
      [K_DOC, { status: "approved", kind: "reference_document" }],
    ]),
    clinicProfiles: new Map([[PROFILE, { status: "approved" }]]),
    ...over,
  };
}

/** The demo CDS graph: request → patient data → indication? → protocol → final; No → instruction → final. */
function cdsGraph(): AgentGraph {
  return {
    nodes: [
      { id: "start", type: "start", label: "Referral", position: { x: 0, y: 0 } },
      { id: "patient", type: "patient_service", label: "Patient data", executionKind: "ai", prompt: { promptId: "p-1", revisionId: "r-2" } },
      { id: "hasInd", type: "decision", label: "Indication present?", condition: { nodeId: "patient", field: "hasIndication", operator: "eq", value: true } },
      { id: "proto", type: "protocol_lookup", label: "CT 01 protocol", knowledgeRevisionId: K_PROTO, inputBindings: { indication: { nodeId: "patient", field: "indicationCode" } } },
      { id: "ask", type: "instruction", label: "Ask for indication" },
      { id: "final", type: "final_synthesis", label: "Review summary", executionKind: "ai", prompt: { draftText: "Summarize matched protocol with evidence." }, outputCategories: ["protocol_match", "missing_data_notice"] },
    ],
    edges: [
      { id: "e1", from: "start", port: "out", to: "patient" },
      { id: "e2", from: "patient", port: "out", to: "hasInd" },
      { id: "e3", from: "hasInd", port: "yes", to: "proto" },
      { id: "e4", from: "hasInd", port: "no", to: "ask" },
      { id: "e5", from: "proto", port: "out", to: "final" },
      { id: "e6", from: "ask", port: "out", to: "final" },
    ],
  };
}

function voiceGraph(): AgentGraph {
  return {
    nodes: [
      { id: "start", type: "start", label: "Incoming call" },
      { id: "auth", type: "verify_authority", label: "Verify caller" },
      { id: "ok", type: "decision", label: "Verified?", condition: { nodeId: "auth", field: "verified", operator: "eq", value: true } },
      { id: "order", type: "resolve_order", label: "Find order" },
      { id: "profile", type: "clinic_profile", label: "CT clinic", clinicProfileId: PROFILE },
      { id: "instr", type: "patient_instructions", label: "Prep instructions", knowledgeRevisionId: K_DOC },
      { id: "slots", type: "offer_slots", label: "Offer slots" },
      { id: "confirm", type: "confirmation", label: "Read back" },
      { id: "book", type: "book", label: "Book" },
      { id: "staff", type: "transfer_staff", label: "Staff" },
      { id: "end", type: "end_call", label: "End" },
    ],
    edges: [
      { id: "v1", from: "start", port: "out", to: "auth" },
      { id: "v2", from: "auth", port: "out", to: "ok" },
      { id: "v3", from: "ok", port: "yes", to: "order" },
      { id: "v4", from: "ok", port: "no", to: "staff" },
      { id: "v5", from: "order", port: "out", to: "profile" },
      { id: "v6", from: "profile", port: "out", to: "instr" },
      { id: "v7", from: "instr", port: "out", to: "slots" },
      { id: "v8", from: "slots", port: "out", to: "confirm" },
      { id: "v9", from: "confirm", port: "yes", to: "book" },
      { id: "v10", from: "confirm", port: "no", to: "end" },
    ],
  };
}

const codes = (g: AgentGraph, c = ctx()) => validate(g, c).map((i) => i.code);

describe("CDS graph", () => {
  it("the demo graph compiles to a manifest with a stable hash", () => {
    const r = compile(cdsGraph(), ctx());
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.manifestHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(r.manifest!.sourceBindings).toEqual([K_PROTO]);
    expect((r.manifest!.effectivePolicy as { rules: { id: string }[] }).rules.map((x) => x.id)).toEqual(["P01", "P02", "P03", "P04", "P05", "P06", "P07", "P08"]);
    expect(r.preview[0]).toBe("1. Referral (Start)");
    expect(r.preview.join("\n")).toContain("Indication present? (Decision) — if Patient data.hasIndication eq true; yes → CT 01 protocol, no → Ask for indication");
  });

  it("moving blocks doesn't change the hash; changing a label or prompt does", () => {
    const a = compile(cdsGraph(), ctx()).manifestHash;
    const moved = cdsGraph();
    moved.nodes.forEach((n, i) => (n.position = { x: i * 100, y: 50 }));
    moved.nodes.reverse();
    moved.edges.reverse();
    expect(compile(moved, ctx()).manifestHash).toBe(a);
    const relabeled = cdsGraph();
    relabeled.nodes[2].label = "Clinical indication present?";
    expect(compile(relabeled, ctx()).manifestHash).not.toBe(a);
    const reprompt = cdsGraph();
    reprompt.nodes[1].prompt = { promptId: "p-1", revisionId: "r-3" };
    expect(compile(reprompt, ctx()).manifestHash).not.toBe(a);
  });

  it("structure: one start, one final, no cycles, no dead ends, both decision exits, all reachable", () => {
    const g = cdsGraph();
    g.edges = g.edges.filter((e) => e.id !== "e4");
    expect(codes(g)).toEqual(["missing_branch", "unreachable"]);
    const loop = cdsGraph();
    loop.edges.push({ id: "back", from: "ask", port: "out", to: "patient" });
    expect(codes(loop)).toContain("cycle");
    const twoStarts = cdsGraph();
    twoStarts.nodes.push({ id: "s2", type: "start", label: "Again" });
    expect(codes(twoStarts)).toEqual(expect.arrayContaining(["start_count", "dead_end"]));
    const noFinal = cdsGraph();
    noFinal.nodes = noFinal.nodes.filter((n) => n.id !== "final");
    noFinal.edges = noFinal.edges.filter((e) => e.to !== "final");
    expect(codes(noFinal)).toEqual(expect.arrayContaining(["final_count", "dead_end"]));
  });

  it("ports, ids and block types", () => {
    const g = cdsGraph();
    g.edges[2] = { ...g.edges[2], port: "maybe" };
    g.nodes.push({ id: "book", type: "book", label: "Book" });
    g.nodes.push({ id: "start", type: "instruction", label: "dup" });
    expect(codes(g)).toEqual(expect.arrayContaining(["bad_port", "type_not_allowed", "duplicate_id"]));
  });

  it("typed bindings must point upstream at real output fields", () => {
    const g = cdsGraph();
    g.nodes[3].inputBindings = { indication: { nodeId: "final", field: "summary" } };
    expect(codes(g)).toContain("binding_not_upstream");
    g.nodes[3].inputBindings = { indication: { nodeId: "patient", field: "favouriteColour" } };
    expect(codes(g)).toContain("binding_field");
  });

  it("typed decisions: operator and value must fit the field (unknown is never false)", () => {
    const bad = (condition: unknown) => {
      const g = cdsGraph();
      g.nodes[2].condition = condition as never;
      return codes(g);
    };
    expect(bad(null)).toContain("condition_required");
    expect(bad({ nodeId: "patient", field: "hasIndication", operator: "eq", value: "yes" })).toContain("condition_value");
    expect(bad({ nodeId: "patient", field: "ageYears", operator: "gt", value: "18" })).toContain("condition_value");
    expect(bad({ nodeId: "patient", field: "sex", operator: "eq", value: "other" })).toContain("condition_value");
    expect(bad({ nodeId: "patient", field: "records", operator: "eq", value: "x" })).toContain("condition_value");
    expect(bad({ nodeId: "patient", field: "ageYears", operator: "like", value: 1 })).toContain("condition_operator");
    expect(bad({ nodeId: "proto", field: "matched", operator: "eq", value: true })).toContain("condition_source");
    expect(bad({ nodeId: "patient", field: "egfr", operator: "gte", value: 30 })).toEqual([]);
    expect(bad({ nodeId: "patient", field: "sex", operator: "in", value: ["female", "male"] })).toEqual([]);
    expect(bad({ nodeId: "patient", field: "records", operator: "exists" })).toEqual([]);
  });

  it("only approved knowledge of the right kind", () => {
    const g = cdsGraph();
    g.nodes[3].knowledgeRevisionId = K_DRAFT;
    expect(codes(g)).toContain("knowledge_not_approved");
    g.nodes[3].knowledgeRevisionId = K_RULE;
    expect(codes(g)).toContain("knowledge_kind");
    g.nodes[3].knowledgeRevisionId = null;
    expect(codes(g)).toContain("knowledge_required");
  });

  it("AI budget (2 calls), AI only on capable blocks, prompts for AI steps and the agent", () => {
    const g = cdsGraph();
    g.nodes[4].executionKind = "ai";
    expect(codes(g)).toEqual(expect.arrayContaining(["ai_not_allowed", "ai_budget", "prompt_required"]));
    const noPrompt = cdsGraph();
    noPrompt.nodes[5].prompt = { draftText: "  " };
    expect(codes(noPrompt, ctx({ agentPrompt: null }))).toEqual(expect.arrayContaining(["prompt_required", "agent_prompt_required"]));
    expect(codes(g, ctx({ maxAiCalls: 3 }))).not.toContain("ai_budget");
  });

  it("prohibitions: deny wins over selected outputs; custom rules must be mapped and reviewed", () => {
    const g = cdsGraph();
    g.nodes[5].outputCategories = ["protocol_match", "alternative_exam"];
    expect(codes(g)).toEqual([]);
    expect(codes(g, ctx({ prohibitions: { optional: ["P10"], custom: [] } }))).toEqual(["output_prohibited"]);
    const custom = (binding: unknown, reviewed: boolean) =>
      codes(cdsGraph(), ctx({ prohibitions: { optional: [], custom: [{ id: "C1", text: "Do not mention costs", owner: "Dr", binding: binding as never, reviewed }] } }));
    expect(custom(null, false)).toEqual(["prohibition_unmapped"]);
    expect(custom({ type: "deny_output", category: "treatment_suggestion" }, false)).toEqual(["prohibition_unreviewed"]);
    expect(custom({ type: "deny_output", category: "treatment_suggestion" }, true)).toEqual([]);
    const r = compile(cdsGraph(), ctx({ prohibitions: { optional: ["P09"], custom: [] } }));
    expect((r.manifest!.effectivePolicy as { rules: { id: string; origin: string }[] }).rules.at(-1)).toEqual({ id: "P09", origin: "agent", binding: { type: "deny_output", category: "dose_suggestion" } });
  });

  it("canonical JSON sorts keys", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
  });
});

describe("voice scheduling graph", () => {
  const vctx = (over: Partial<CompileContext> = {}) => ctx({ kind: "voice", executionMode: "voice_scheduling", agentPrompt: { promptId: "pv", revisionId: "rv" }, ...over });

  it("the guarded graph compiles", () => {
    const r = compile(voiceGraph(), vctx());
    expect(r.issues).toEqual([]);
    expect(r.manifest!.clinicProfiles).toEqual([PROFILE]);
    expect((r.manifest!.effectivePolicy as { rules: { id: string }[] }).rules.map((x) => x.id)).toEqual(["P03", "P04", "P05", "P06", "P07", "V01", "V02", "V03", "V04"]);
  });

  it("a path to booking that skips verification is rejected", () => {
    const g = voiceGraph();
    g.edges = g.edges.filter((e) => e.id !== "v4");
    g.nodes = g.nodes.filter((n) => n.id !== "staff");
    g.edges.push({ id: "v4b", from: "ok", port: "no", to: "order" }); // a No path still went through Verify caller
    expect(codes(g, vctx())).toEqual([]);
    const skip = voiceGraph();
    skip.nodes.push({ id: "shortcut", type: "resolve_order", label: "Order (no auth)" });
    skip.edges.push({ id: "s1", from: "start", port: "out", to: "shortcut" }, { id: "s2", from: "shortcut", port: "out", to: "profile" });
    expect(codes(skip, vctx())).toContain("booking_guard");
  });

  it("booking must come directly after a confirmed read-back", () => {
    const g = voiceGraph();
    g.edges = g.edges.map((e) => (e.id === "v8" ? { ...e, to: "book" } : e));
    expect(codes(g, vctx())).toEqual(expect.arrayContaining(["confirm_before_book"]));
    const no = voiceGraph();
    no.edges = no.edges.map((e) => (e.id === "v9" ? { ...e, port: "no" } : e.id === "v10" ? { ...e, port: "yes" } : e));
    expect(codes(no, vctx())).toContain("confirm_before_book");
  });

  it("clinic profile must be approved; CDS blocks are not allowed in voice", () => {
    expect(codes(voiceGraph(), vctx({ clinicProfiles: new Map([[PROFILE, { status: "draft" }]]) }))).toContain("profile_not_approved");
    const g = voiceGraph();
    g.nodes.push({ id: "p", type: "protocol_lookup", label: "Protocol", knowledgeRevisionId: K_PROTO });
    expect(codes(g, vctx())).toContain("type_not_allowed");
  });
});
