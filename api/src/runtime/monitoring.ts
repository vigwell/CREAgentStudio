/**
 * Operational monitoring (spec §18 "Operational monitoring"): volume, time,
 * missing-data stops, policy blocks, review outcomes and AI use/cost, per
 * agent and department, for a period. Tenant-scoped like everything else.
 *
 * Counts only, never clinical content. Review acceptance is not a measure of
 * clinical accuracy (the page says so).
 */
import sql from "mssql";
import type { Db } from "../db/pool.js";
import { withTenant } from "../db/tenant.js";
import type { StudioUser } from "../services/users.js";

export interface MonitoringQuery {
  days: number;
  agentId?: string;
  purpose?: "clinical" | "test";
}

export interface AiPrice {
  /** USD per million input / output tokens; null = cost not shown. */
  inputPerMTok: number;
  outputPerMTok: number;
}

const MAX_RUNS = 5000;
const OUTCOMES = ["findings", "needs_input", "needs_review", "not_applicable", "blocked", "unavailable"] as const;

type Row = { agent_id: string; name: string; scope: string | null; outcome: string; result: string | null };
type RunJson = {
  durationMs?: number;
  missingInputs?: string[];
  blockedFindings?: { ruleIds: string[] }[];
  findings?: unknown[];
  aiCalls?: { status: string; ms: number | null; inputTokens: number | null; outputTokens: number | null }[];
};

export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

const top = (m: Map<string, number>, n = 10) =>
  [...m.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([key, count]) => ({ key, count }));

/** Pure aggregation over run rows (tested without a database). */
export function aggregate(rows: Row[], reviews: { action: string; n: number }[], price: AiPrice | null) {
  const outcomes = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<string, number>;
  const missing = new Map<string, number>();
  const blocks = new Map<string, number>();
  const aiStatus = new Map<string, number>();
  const durations: number[] = [];
  const aiMs: number[] = [];
  let findings = 0;
  let inTok = 0;
  let outTok = 0;
  const agents = new Map<string, { agentId: string; name: string; department: string | null; runs: number; needsInput: number; needsReview: number; blocked: number; aiCalls: number; tokens: number }>();

  for (const r of rows) {
    outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
    let res: RunJson = {};
    try {
      res = JSON.parse(String(r.result ?? "{}"));
    } catch {
      /* unreadable result: counted by outcome only */
    }
    if (typeof res.durationMs === "number") durations.push(res.durationMs);
    for (const f of res.missingInputs ?? []) missing.set(f, (missing.get(f) ?? 0) + 1);
    for (const b of res.blockedFindings ?? []) for (const id of b.ruleIds) blocks.set(id, (blocks.get(id) ?? 0) + 1);
    findings += res.findings?.length ?? 0;
    let calls = 0;
    let tokens = 0;
    for (const c of res.aiCalls ?? []) {
      aiStatus.set(c.status, (aiStatus.get(c.status) ?? 0) + 1);
      if (c.ms != null) {
        calls += 1;
        aiMs.push(c.ms);
      }
      inTok += c.inputTokens ?? 0;
      outTok += c.outputTokens ?? 0;
      tokens += (c.inputTokens ?? 0) + (c.outputTokens ?? 0);
    }
    const id = String(r.agent_id).toLowerCase();
    let scope: { department?: unknown } = {};
    try {
      scope = JSON.parse(String(r.scope ?? "{}"));
    } catch {
      /* no scope */
    }
    const a = agents.get(id) ?? { agentId: id, name: r.name, department: typeof scope.department === "string" ? scope.department : null, runs: 0, needsInput: 0, needsReview: 0, blocked: 0, aiCalls: 0, tokens: 0 };
    a.runs += 1;
    if (r.outcome === "needs_input") a.needsInput += 1;
    if (r.outcome === "needs_review") a.needsReview += 1;
    if (r.outcome === "blocked" || (res.blockedFindings?.length ?? 0) > 0) a.blocked += 1;
    a.aiCalls += calls;
    a.tokens += tokens;
    agents.set(id, a);
  }
  durations.sort((a, b) => a - b);
  aiMs.sort((a, b) => a - b);
  const departments = new Map<string, number>();
  for (const a of agents.values()) departments.set(a.department ?? "", (departments.get(a.department ?? "") ?? 0) + a.runs);

  return {
    runs: rows.length,
    outcomes,
    findings,
    time: { measured: durations.length, p50Ms: percentile(durations, 50), p95Ms: percentile(durations, 95), maxMs: durations.at(-1) ?? null },
    missingInputs: top(missing),
    policyBlocks: top(blocks),
    reviews: Object.fromEntries(["acknowledge", "dismiss", "defer"].map((a) => [a, reviews.find((x) => x.action === a)?.n ?? 0])),
    ai: {
      calls: aiMs.length,
      byStatus: top(aiStatus, 20),
      inputTokens: inTok,
      outputTokens: outTok,
      p50Ms: percentile(aiMs, 50),
      costUsd: price ? Math.round(((inTok * price.inputPerMTok + outTok * price.outputPerMTok) / 1e6) * 100) / 100 : null,
    },
    byAgent: [...agents.values()].sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name)),
    byDepartment: [...departments.entries()].map(([department, runs]) => ({ department: department || null, runs })).sort((a, b) => b.runs - a.runs),
  };
}

export class MonitoringService {
  constructor(
    private readonly db: Db,
    private readonly price: AiPrice | null = null,
  ) {}

  async summary(user: StudioUser, q: MonitoringQuery) {
    const to = new Date();
    const from = new Date(to.getTime() - q.days * 86_400_000);
    return withTenant(this.db, user.tenantId, async (tx) => {
      const filters = (req: sql.Request) => {
        req.input("from", sql.DateTime2, from);
        if (q.agentId) req.input("agent", sql.UniqueIdentifier, q.agentId);
        if (q.purpose) req.input("purpose", sql.NVarChar(20), q.purpose);
        return req;
      };
      const where = `r.created_at >= @from${q.agentId ? " AND r.agent_id = @agent" : ""}${q.purpose ? " AND r.purpose = @purpose" : ""}`;
      const rows = (
        await filters(new sql.Request(tx)).query<Row>(
          `SELECT TOP (${MAX_RUNS + 1}) r.agent_id, a.name, a.scope, r.outcome, r.result
           FROM studio.agent_runs r JOIN studio.agents a ON a.id = r.agent_id
           WHERE ${where} ORDER BY r.created_at DESC`,
        )
      ).recordset;
      const reviews = (
        await filters(new sql.Request(tx)).query<{ action: string; n: number }>(
          `SELECT rr.action, COUNT(*) AS n FROM studio.run_reviews rr JOIN studio.agent_runs r ON r.id = rr.run_id
           WHERE ${where} GROUP BY rr.action`,
        )
      ).recordset;
      const truncated = rows.length > MAX_RUNS;
      return {
        period: { from: from.toISOString(), to: to.toISOString(), days: q.days },
        filters: { agentId: q.agentId ?? null, purpose: q.purpose ?? null },
        truncated,
        ...aggregate(truncated ? rows.slice(0, MAX_RUNS) : rows, reviews, this.price),
      };
    });
  }
}
