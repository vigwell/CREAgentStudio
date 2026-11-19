import { describe, expect, it } from "vitest";
import { aggregate, percentile } from "../src/runtime/monitoring.js";

const run = (agent: string, outcome: string, result: Record<string, unknown>, scope = { department: "Radiology" }) => ({
  agent_id: agent.toUpperCase(),
  name: `Agent ${agent}`,
  scope: JSON.stringify(scope),
  outcome,
  result: JSON.stringify(result),
});

describe("monitoring aggregate", () => {
  it("percentile", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
  });

  it("counts outcomes, time, missing data, policy blocks, reviews and AI use per agent and department", () => {
    const rows = [
      run("a", "findings", { durationMs: 1200, findings: [{}, {}], aiCalls: [{ status: "used", ms: 900, inputTokens: 400, outputTokens: 100 }, { status: "used", ms: 1100, inputTokens: 500, outputTokens: 60 }] }),
      run("a", "needs_input", { durationMs: 300, missingInputs: ["egfr", "indicationCode"], findings: [{}], aiCalls: [{ status: "no_note", ms: null, inputTokens: null, outputTokens: null }] }),
      run("a", "findings", { durationMs: 800, blockedFindings: [{ ruleIds: ["P09"] }], findings: [] }),
      run("b", "needs_input", { missingInputs: ["egfr"] }, { department: "ER" } as never),
      { ...run("b", "unavailable", {}), result: "not json" },
    ];
    const m = aggregate(rows, [{ action: "acknowledge", n: 3 }, { action: "defer", n: 1 }], { inputPerMTok: 2, outputPerMTok: 8 });
    expect(m.runs).toBe(5);
    expect(m.outcomes).toMatchObject({ findings: 2, needs_input: 2, unavailable: 1, blocked: 0 });
    expect(m.findings).toBe(3);
    expect(m.time).toEqual({ measured: 3, p50Ms: 800, p95Ms: 1200, maxMs: 1200 });
    expect(m.missingInputs).toEqual([{ key: "egfr", count: 2 }, { key: "indicationCode", count: 1 }]);
    expect(m.policyBlocks).toEqual([{ key: "P09", count: 1 }]);
    expect(m.reviews).toEqual({ acknowledge: 3, dismiss: 0, defer: 1 });
    expect(m.ai).toMatchObject({ calls: 2, inputTokens: 900, outputTokens: 160, p50Ms: 900, byStatus: [{ key: "used", count: 2 }, { key: "no_note", count: 1 }] });
    expect(m.ai.costUsd).toBe(0); // (900*2 + 160*8)/1e6 = 0.003 → rounds to 0.00
    expect(m.byAgent[0]).toMatchObject({ agentId: "a", runs: 3, needsInput: 1, blocked: 1, aiCalls: 2, tokens: 1060, department: "Radiology" });
    expect(m.byDepartment).toEqual([{ department: "Radiology", runs: 3 }, { department: "ER", runs: 2 }]);
  });

  it("no price means no cost; no runs gives zeros and nulls", () => {
    const m = aggregate([], [], null);
    expect(m).toMatchObject({ runs: 0, findings: 0, time: { measured: 0, p50Ms: null }, ai: { calls: 0, costUsd: null }, byAgent: [], byDepartment: [] });
  });
});
