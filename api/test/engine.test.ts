import { describe, expect, it } from "vitest";
import { evaluate, execute, matchRows, snapshotHash, type InputSnapshot, type KnowledgeBinding, type Manifest } from "../src/runtime/engine.js";

const protocols: KnowledgeBinding = {
  revisionId: "rev-p",
  sourceName: "CT 01 protocols",
  kind: "device_protocol",
  status: "approved",
  rows: [
    { rowId: "P01", sheet: "Protocols", originalRow: 8, mapped: { protocolCode: "CT-HEAD-01", conditionCode: "DEMO-A" }, hasErrors: false },
    { rowId: "P02", sheet: "Protocols", originalRow: 9, mapped: { protocolCode: "CT-CHEST-02", conditionCode: "DEMO-B" }, hasErrors: false },
    { rowId: "P03", sheet: "Protocols", originalRow: 10, mapped: { protocolCode: "CT-CHEST-03", conditionCode: "DEMO-B" }, hasErrors: false },
    { rowId: "P04", sheet: "Protocols", originalRow: 11, mapped: { protocolCode: "BAD", conditionCode: "DEMO-C" }, hasErrors: true },
  ],
};

function manifest(extra: Partial<Manifest> = {}): Manifest {
  return {
    agentId: "a1",
    executionMode: "standalone_cds",
    scope: {},
    nodes: [
      { id: "start", type: "start", label: "Request", executionKind: "deterministic", condition: null, knowledgeRevisionId: null, outputCategories: [] },
      { id: "patient", type: "patient_service", label: "Patient", executionKind: "deterministic", condition: null, knowledgeRevisionId: null, outputCategories: [] },
      { id: "has", type: "decision", label: "Has indication?", executionKind: "deterministic", condition: { nodeId: "patient", field: "hasIndication", operator: "eq", value: true }, knowledgeRevisionId: null, outputCategories: [] },
      { id: "lookup", type: "protocol_lookup", label: "Protocol", executionKind: "deterministic", condition: null, knowledgeRevisionId: "rev-p", outputCategories: [] },
      { id: "note", type: "instruction", label: "Ask the referrer for an indication", executionKind: "deterministic", condition: null, knowledgeRevisionId: null, outputCategories: [] },
      { id: "final", type: "final_synthesis", label: "Summary", executionKind: "ai", condition: null, knowledgeRevisionId: null, outputCategories: ["protocol_match", "safety_flag"] },
    ],
    edges: [
      { id: "e1", from: "start", port: "out", to: "patient" },
      { id: "e2", from: "patient", port: "out", to: "has" },
      { id: "e3", from: "has", port: "yes", to: "lookup" },
      { id: "e4", from: "has", port: "no", to: "note" },
      { id: "e5", from: "lookup", port: "out", to: "final" },
      { id: "e6", from: "note", port: "out", to: "final" },
    ],
    effectivePolicy: { rules: [] },
    ...extra,
  };
}

const snap = (facts: InputSnapshot["facts"]): InputSnapshot => ({ caseRef: "case-104", requestedAt: "2026-11-12T08:00:00Z", facts });
const present = (value: unknown) => ({ value, status: "present" as const, sourceRef: "encounter-104", observedAt: "2026-11-12T07:00:00Z", attribution: { kind: "source" as const } });
const k = new Map([["rev-p", protocols]]);

describe("evaluate", () => {
  it("unknown is never false", () => {
    const U = matchRows({ ...protocols, rows: [] }, snap({})); // just to touch the export
    expect(U.rows).toEqual([]);
    expect(evaluate(5, "gt", 3)).toBe(true);
    expect(evaluate("2026-01-02", "lt", "2026-02-01")).toBe(true);
    expect(evaluate("demo-a", "eq", "DEMO-A")).toBe(true);
    expect(evaluate("x", "in", ["x", "y"])).toBe(true);
    expect(evaluate("abc", "gt", 3)).not.toBe(true);
  });
});

describe("CDS run engine", () => {
  it("one matching row: a protocol finding with the exact row as evidence; the other branch is skipped", () => {
    const r = execute(manifest(), snap({ indicationCode: present("DEMO-A") }), k);
    expect(r.state).toBe("completed");
    expect(r.outcome).toBe("findings");
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ code: "PROTOCOL_MATCH_REVIEW", evidence: [{ rowId: "P01", sheet: "Protocols", sourceRow: 8, knowledgeRevisionId: "rev-p" }] });
    expect(r.findings[0].observedInputs[0]).toMatchObject({ field: "indicationCode", value: "DEMO-A", sourceRef: "encounter-104" });
    const states = Object.fromEntries(r.trace.map((t) => [t.nodeId, t.state]));
    expect(states).toMatchObject({ has: "completed", lookup: "completed", note: "skipped", final: "completed" });
    expect(r.trace.find((t) => t.nodeId === "has")!.port).toBe("yes");
    expect(r.summary!.ai).toBe("not_configured");
  });

  it("several matches or none: needs_review with every row, never a default", () => {
    const two = execute(manifest(), snap({ indicationCode: present("DEMO-B") }), k);
    expect(two.outcome).toBe("needs_review");
    expect(two.findings[0].code).toBe("PROTOCOL_CONFLICT");
    expect(two.findings[0].evidence.map((e) => e.rowId)).toEqual(["P02", "P03"]);
    const none = execute(manifest(), snap({ indicationCode: present("DEMO-Z") }), k);
    expect(none.outcome).toBe("needs_review");
    expect(none.findings[0].code).toBe("PROTOCOL_NO_MATCH");
    const errored = execute(manifest(), snap({ indicationCode: present("DEMO-C") }), k);
    expect(errored.findings[0].code).toBe("PROTOCOL_NO_MATCH"); // rows with errors never match
  });

  it("missing data pauses the run and names the field; downstream is not reached", () => {
    const r = execute(manifest(), snap({ indicationCode: { status: "denied" } }), k);
    expect(r.state).toBe("awaiting_input");
    expect(r.outcome).toBe("needs_input");
    expect(r.missingInputs).toEqual(["hasIndication"]);
    expect(r.trace.find((t) => t.nodeId === "has")!.port).toBe("unknown");
    expect(r.trace.find((t) => t.nodeId === "final")!.state).toBe("not_reached");
  });

  it("a verified false takes the no branch", () => {
    const r = execute(manifest(), snap({ hasIndication: present(false) }), k);
    expect(r.trace.find((t) => t.nodeId === "has")!.port).toBe("no");
    expect(r.findings.map((f) => f.code)).toEqual(["INSTRUCTION"]);
    expect(r.trace.find((t) => t.nodeId === "lookup")!.state).toBe("skipped");
  });

  it("a withdrawn or expired source blocks the run", () => {
    const r = execute(manifest(), snap({ indicationCode: present("DEMO-A") }), new Map([["rev-p", { ...protocols, status: "expired" }]]));
    expect(r.outcome).toBe("blocked");
    expect(r.trace.find((t) => t.nodeId === "lookup")!.state).toBe("blocked");
    expect(r.findings).toEqual([]);
  });

  it("findings in a denied output category are dropped and recorded", () => {
    const m = manifest({ effectivePolicy: { rules: [{ id: "C01", binding: { type: "deny_output", category: "protocol_match" } }] } });
    const r = execute(m, snap({ indicationCode: present("DEMO-A") }), k);
    expect(r.findings).toEqual([]);
    expect(r.blockedFindings).toEqual([{ code: "PROTOCOL_MATCH_REVIEW", category: "protocol_match", ruleIds: ["C01"] }]);
    expect(r.outcome).toBe("not_applicable");
  });

  it("age limits on a row need the age; unknown age asks for input", () => {
    const b: KnowledgeBinding = { ...protocols, rows: [{ rowId: "A1", sheet: null, originalRow: 2, mapped: { protocolCode: "X", conditionCode: "DEMO-A", ageMinYears: 18 }, hasErrors: false }] };
    const r = execute(manifest(), snap({ indicationCode: present("DEMO-A") }), new Map([["rev-p", b]]));
    expect(r.outcome).toBe("needs_input");
    expect(r.missingInputs).toEqual(["ageYears"]);
    const ok = execute(manifest(), snap({ indicationCode: present("DEMO-A"), ageYears: present(40) }), new Map([["rev-p", b]]));
    expect(ok.outcome).toBe("findings");
  });

  it("the snapshot hash is stable for equal content", () => {
    expect(snapshotHash(snap({ a: present(1), b: present(2) }))).toBe(snapshotHash(snap({ b: present(2), a: present(1) })));
  });
});
