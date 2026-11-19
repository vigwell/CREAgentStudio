/**
 * Scenario tests (spec rev 7 §20): a saved case = test inputs plus the expected
 * structured result (outcome, finding codes, and the path through the graph).
 * Assertions are on routing and structured outcomes, never on wording.
 */
import { execute, type InputSnapshot, type KnowledgeBinding, type Manifest, type RunResult } from "../runtime/engine.js";
import { factsFromManual } from "../runtime/service.js";

export interface TestInputs {
  manualValues: Record<string, unknown>;
  deviceId?: string | null;
}

export interface PathStep {
  nodeId: string;
  state: string;
  port?: string;
}

export interface Expected {
  outcome: string;
  /** Finding codes, any order; omitted = not checked. */
  findingCodes?: string[];
  /** Steps that must appear with this state (and decision port); omitted = not checked. */
  path?: PathStep[];
  /** Output categories that must have been withheld by a prohibition. */
  blockedCategories?: string[];
}

/** One mismatch, structured so the UI can say it in the user's language. */
export interface Problem {
  kind: "outcome" | "findings" | "step_missing" | "step_state" | "step_port" | "blocked" | "error";
  nodeId?: string;
  expected?: unknown;
  actual?: unknown;
}

export interface CaseResult {
  testCaseId: string;
  name: string;
  passed: boolean;
  problems: Problem[];
  actual: { outcome: string; findingCodes: string[]; path: PathStep[]; blockedCategories: string[] };
}

export function actualOf(r: RunResult): CaseResult["actual"] {
  return {
    outcome: r.outcome,
    findingCodes: r.findings.map((f) => f.code).sort(),
    path: r.trace.map((n) => ({ nodeId: n.nodeId, state: n.state, ...(n.port ? { port: n.port } : {}) })),
    blockedCategories: [...new Set(r.blockedFindings.map((b) => b.category))].sort(),
  };
}

/** Compare one run with what the case expects; each mismatch is a readable problem. */
export function compare(expected: Expected, actual: CaseResult["actual"]): Problem[] {
  const problems: Problem[] = [];
  if (expected.outcome !== actual.outcome) problems.push({ kind: "outcome", expected: expected.outcome, actual: actual.outcome });
  if (expected.findingCodes) {
    const e = [...expected.findingCodes].sort();
    if (e.join(",") !== actual.findingCodes.join(",")) problems.push({ kind: "findings", expected: e, actual: actual.findingCodes });
  }
  for (const step of expected.path ?? []) {
    const got = actual.path.find((p) => p.nodeId === step.nodeId);
    if (!got) problems.push({ kind: "step_missing", nodeId: step.nodeId });
    else if (got.state !== step.state) problems.push({ kind: "step_state", nodeId: step.nodeId, expected: step.state, actual: got.state });
    else if (step.port && got.port !== step.port) problems.push({ kind: "step_port", nodeId: step.nodeId, expected: step.port, actual: got.port ?? null });
  }
  for (const c of expected.blockedCategories ?? []) {
    if (!actual.blockedCategories.includes(c)) problems.push({ kind: "blocked", expected: c });
  }
  return problems;
}

/** Run one saved case against a candidate, in memory (no snapshot, no run record, no live writes). */
export function runCase(
  manifest: Manifest,
  knowledge: Map<string, KnowledgeBinding>,
  tc: { id: string; name: string; inputs: TestInputs; expected: Expected },
  userId: string,
  now = new Date().toISOString(),
): CaseResult {
  let actual: CaseResult["actual"];
  try {
    const snapshot: InputSnapshot = {
      caseRef: `test:${tc.id}`,
      requestedAt: now,
      deviceId: tc.inputs.deviceId ?? null,
      facts: factsFromManual(tc.inputs.manualValues ?? {}, userId, now),
    };
    actual = actualOf(execute(manifest, snapshot, knowledge));
  } catch (err) {
    return {
      testCaseId: tc.id,
      name: tc.name,
      passed: false,
      problems: [{ kind: "error", actual: String((err as Error).message).slice(0, 300) }],
      actual: { outcome: "error", findingCodes: [], path: [], blockedCategories: [] },
    };
  }
  const problems = compare(tc.expected, actual);
  return { testCaseId: tc.id, name: tc.name, passed: problems.length === 0, problems, actual };
}

/** Semantic difference between two manifests (what an approver must see). */
export function manifestDiff(
  a: Record<string, unknown> | null,
  b: Record<string, unknown>,
): { added: string[]; removed: string[]; changed: string[] } {
  const out = { added: [] as string[], removed: [] as string[], changed: [] as string[] };
  type N = { id: string; label?: string; [k: string]: unknown };
  const nodesA = new Map(((a?.nodes as N[]) ?? []).map((n) => [n.id, n]));
  const nodesB = new Map(((b.nodes as N[]) ?? []).map((n) => [n.id, n]));
  for (const [id, n] of nodesB) {
    const old = nodesA.get(id);
    if (!old) out.added.push(`block ${n.label ?? id}`);
    else if (JSON.stringify(old) !== JSON.stringify(n)) out.changed.push(`block ${n.label ?? id}`);
  }
  for (const [id, n] of nodesA) if (!nodesB.has(id)) out.removed.push(`block ${n.label ?? id}`);
  type E = { from: string; port: string; to: string };
  const key = (e: E) => `${e.from} ${e.port} → ${e.to}`;
  const edgesA = new Set(((a?.edges as E[]) ?? []).map(key));
  const edgesB = new Set(((b.edges as E[]) ?? []).map(key));
  for (const e of edgesB) if (!edgesA.has(e)) out.added.push(`connection ${e}`);
  for (const e of edgesA) if (!edgesB.has(e)) out.removed.push(`connection ${e}`);
  for (const field of ["agentPrompt", "effectivePolicy", "sourceBindings", "clinicProfiles", "scope", "budget"]) {
    if (JSON.stringify(a?.[field] ?? null) !== JSON.stringify(b[field] ?? null)) out.changed.push(field);
  }
  return out;
}
