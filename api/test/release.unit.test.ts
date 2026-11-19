import { describe, expect, it } from "vitest";
import { compare, manifestDiff, runCase } from "../src/release/testing.js";
import type { KnowledgeBinding, Manifest } from "../src/runtime/engine.js";

const manifest: Manifest = {
  agentId: "a",
  executionMode: "standalone_cds",
  scope: {},
  nodes: [
    { id: "start", type: "start", label: "Start", executionKind: "deterministic", condition: null, knowledgeRevisionId: null, outputCategories: [] },
    { id: "patient", type: "patient_service", label: "Patient", executionKind: "deterministic", condition: null, knowledgeRevisionId: null, outputCategories: [] },
    { id: "has", type: "decision", label: "Has?", executionKind: "deterministic", condition: { nodeId: "patient", field: "hasIndication", operator: "eq", value: true }, knowledgeRevisionId: null, outputCategories: [] },
    { id: "proto", type: "protocol_lookup", label: "Protocol", executionKind: "deterministic", condition: null, knowledgeRevisionId: "k", outputCategories: [] },
    { id: "ask", type: "instruction", label: "Ask", executionKind: "deterministic", condition: null, knowledgeRevisionId: null, outputCategories: [] },
    { id: "final", type: "final_synthesis", label: "Final", executionKind: "deterministic", condition: null, knowledgeRevisionId: null, outputCategories: ["protocol_match"] },
  ],
  edges: [
    { id: "e1", from: "start", port: "out", to: "patient" },
    { id: "e2", from: "patient", port: "out", to: "has" },
    { id: "e3", from: "has", port: "yes", to: "proto" },
    { id: "e4", from: "has", port: "no", to: "ask" },
    { id: "e5", from: "proto", port: "out", to: "final" },
    { id: "e6", from: "ask", port: "out", to: "final" },
  ],
  effectivePolicy: { rules: [] },
};
const knowledge = new Map<string, KnowledgeBinding>([
  ["k", { revisionId: "k", sourceName: "CT", kind: "device_protocol", status: "approved", rows: [{ rowId: "R1", sheet: "S", originalRow: 2, mapped: { protocolCode: "P1", conditionCode: "DEMO-A" }, hasErrors: false }] }],
]);

describe("scenario tests", () => {
  it("a matching case passes; outcome, findings and path are all checked", () => {
    const r = runCase(manifest, knowledge, {
      id: "t1",
      name: "match",
      inputs: { manualValues: { indicationCode: "DEMO-A" } },
      expected: { outcome: "findings", findingCodes: ["PROTOCOL_MATCH_REVIEW"], path: [{ nodeId: "has", state: "completed", port: "yes" }, { nodeId: "ask", state: "skipped" }] },
    }, "u");
    expect(r.passed).toBe(true);
    expect(r.problems).toEqual([]);
  });

  it("every mismatch is reported, structured", () => {
    const r = runCase(manifest, knowledge, {
      id: "t2",
      name: "wrong",
      inputs: { manualValues: { hasIndication: false } },
      expected: { outcome: "needs_review", findingCodes: ["PROTOCOL_NO_MATCH"], path: [{ nodeId: "has", state: "completed", port: "yes" }, { nodeId: "ghost", state: "completed" }], blockedCategories: ["dose_suggestion"] },
    }, "u");
    expect(r.passed).toBe(false);
    expect(r.problems.map((p) => p.kind)).toEqual(["outcome", "findings", "step_port", "step_missing", "blocked"]);
  });

  it("missing input: needs_input with the decision waiting", () => {
    const problems = compare(
      { outcome: "needs_input", path: [{ nodeId: "has", state: "awaiting_input" }, { nodeId: "final", state: "not_reached" }] },
      runCase(manifest, knowledge, { id: "t3", name: "missing", inputs: { manualValues: {} }, expected: { outcome: "needs_input" } }, "u").actual,
    );
    expect(problems).toEqual([]);
  });

  it("bad test inputs fail the case instead of throwing", () => {
    const r = runCase(manifest, knowledge, { id: "t4", name: "bad", inputs: { manualValues: { ageYears: "old" } }, expected: { outcome: "findings" } }, "u");
    expect(r.passed).toBe(false);
    expect(r.problems[0].kind).toBe("error");
  });

  it("diff lists added, removed and changed blocks, connections and policy", () => {
    const next = {
      ...manifest,
      nodes: [...manifest.nodes.filter((n) => n.id !== "ask"), { ...manifest.nodes[3], label: "Protocol v2" }, { id: "new", type: "instruction", label: "New" }].filter((n, i, a) => a.findIndex((x) => x.id === n.id) === i),
      edges: manifest.edges.filter((e) => e.to !== "ask"),
      effectivePolicy: { rules: [{ id: "P09", binding: null }] },
    };
    const d = manifestDiff(manifest as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>);
    expect(d.added).toContain("block New");
    expect(d.removed).toContain("block Ask");
    expect(d.removed).toContain("connection has no → ask");
    expect(d.changed).toContain("effectivePolicy");
    expect(manifestDiff(null, manifest as unknown as Record<string, unknown>).added.length).toBe(6 + 6);
  });
});
