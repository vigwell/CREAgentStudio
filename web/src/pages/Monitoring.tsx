/**
 * Monitoring: how agents are used and behave over a period — volume, time,
 * stops for missing data, policy blocks, review outcomes and AI use. Counts
 * only; no clinical content.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { AgentSummary, Catalog } from "../api/client";
import { useQuery } from "../api/query";
import { ErrorNote } from "../components/ErrorNote";
import { OUTCOME_TONE } from "../components/RunResult";
import { Field } from "../ui/Field";
import { PageHeader } from "../ui/PageHeader";
import { TableSkeleton } from "../ui/Skeleton";
import { StatusPill } from "../ui/StatusPill";

export interface MonitoringSummary {
  period: { from: string; to: string; days: number };
  truncated: boolean;
  runs: number;
  outcomes: Record<string, number>;
  findings: number;
  time: { measured: number; p50Ms: number | null; p95Ms: number | null; maxMs: number | null };
  missingInputs: { key: string; count: number }[];
  policyBlocks: { key: string; count: number }[];
  reviews: Record<"acknowledge" | "dismiss" | "defer", number>;
  ai: { calls: number; byStatus: { key: string; count: number }[]; inputTokens: number; outputTokens: number; p50Ms: number | null; costUsd: number | null };
  byAgent: { agentId: string; name: string; department: string | null; runs: number; needsInput: number; needsReview: number; blocked: number; aiCalls: number; tokens: number }[];
  byDepartment: { department: string | null; runs: number }[];
}

const OUTCOMES = ["findings", "needs_review", "needs_input", "not_applicable", "blocked", "unavailable"];
const PERIODS = [7, 30, 90];

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card">
      <p className="text-caption font-medium text-ink-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-ink">{value}</p>
      {sub && <p className="mt-1 text-caption text-ink-subtle">{sub}</p>}
    </div>
  );
}

function CountTable({ title, rows, empty, name }: { title: string; rows: { key: string; count: number }[]; empty: string; name: (k: string) => React.ReactNode }) {
  const { i18n } = useTranslation();
  const n = new Intl.NumberFormat(i18n.language);
  return (
    <section className="card space-y-3">
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-subtle">{empty}</p>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {rows.map((r) => (
            <li key={r.key} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0 text-ink">{name(r.key)}</span>
              <span className="tabular-nums font-medium text-ink">{n.format(r.count)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function Monitoring() {
  const { t, i18n } = useTranslation();
  const [f, setF] = useState({ days: "30", agentId: "", purpose: "" });
  const agentsQ = useQuery<{ agents: AgentSummary[] }>("/agents");
  const catalogQ = useQuery<Catalog>("/agents/catalog");
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][]).toString();
  const q = useQuery<MonitoringSummary>(`/monitoring?${qs}`);
  const m = q.data;
  const n = new Intl.NumberFormat(i18n.language);
  const pct = new Intl.NumberFormat(i18n.language, { style: "percent", maximumFractionDigits: 0 });
  const secs = (ms: number | null) => (ms === null ? "–" : t("monitoring.seconds", { value: new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(ms / 1000) }));
  const share = (x: number) => (m && m.runs ? pct.format(x / m.runs) : "");
  const ruleText = (id: string) => [...(catalogQ.data?.mandatoryRules ?? []), ...(catalogQ.data?.optionalRules ?? [])].find((r) => r.id === id)?.text;
  const blocked = m ? m.policyBlocks.reduce((s, b) => s + b.count, 0) : 0;
  const reviewsTotal = m ? m.reviews.acknowledge + m.reviews.dismiss + m.reviews.defer : 0;

  return (
    <div className="space-y-6">
      <PageHeader title={t("monitoring.title")} intro={t("monitoring.intro")} />
      <ErrorNote error={q.error} />
      <div className="card field-grid sm:grid-cols-3">
        <Field label={t("monitoring.period")}>
          <select className="input" value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })}>
            {PERIODS.map((d) => (
              <option key={d} value={d}>
                {t("monitoring.lastDays", { count: d })}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("inspector.agent")}>
          <select className="input" value={f.agentId} onChange={(e) => setF({ ...f, agentId: e.target.value })}>
            <option value="">{t("inspector.all")}</option>
            {(agentsQ.data?.agents ?? [])
              .filter((a) => a.kind === "cds")
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label={t("inspector.purpose")}>
          <select className="input" value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })}>
            <option value="">{t("inspector.all")}</option>
            <option value="clinical">{t("inspector.purposes.clinical")}</option>
            <option value="test">{t("inspector.purposes.test")}</option>
          </select>
        </Field>
      </div>

      {!m ? (
        !q.error && <TableSkeleton cols={4} />
      ) : m.runs === 0 ? (
        <p className="card text-sm text-ink-subtle">{t("monitoring.empty")}</p>
      ) : (
        <>
          {m.truncated && <p className="text-sm text-ink-muted">{t("monitoring.truncated", { count: m.runs })}</p>}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Tile label={t("monitoring.runs")} value={n.format(m.runs)} sub={t("monitoring.findingsCount", { count: m.findings, n: n.format(m.findings) })} />
            <Tile label={t("monitoring.missingStops")} value={n.format(m.outcomes.needs_input ?? 0)} sub={t("monitoring.ofRuns", { share: share(m.outcomes.needs_input ?? 0) })} />
            <Tile label={t("monitoring.time")} value={secs(m.time.p50Ms)} sub={t("monitoring.timeSub", { p95: secs(m.time.p95Ms) })} />
            <Tile
              label={t("monitoring.aiCalls")}
              value={n.format(m.ai.calls)}
              sub={
                m.ai.costUsd !== null
                  ? t("monitoring.aiSubCost", { tokens: n.format(m.ai.inputTokens + m.ai.outputTokens), cost: new Intl.NumberFormat(i18n.language, { style: "currency", currency: "USD" }).format(m.ai.costUsd) })
                  : t("monitoring.aiSub", { tokens: n.format(m.ai.inputTokens + m.ai.outputTokens) })
              }
            />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <section className="card space-y-3">
              <h2 className="text-sm font-semibold text-ink">{t("monitoring.results")}</h2>
              <ul className="divide-y divide-line text-sm">
                {OUTCOMES.map((o) => (
                  <li key={o} className="flex items-center justify-between gap-3 py-2">
                    <StatusPill tone={OUTCOME_TONE[o] ?? "neutral"}>{t(`runs.outcome.${o}`)}</StatusPill>
                    {/* flex, so the count and the share don't merge into one number in RTL */}
                    <span className="inline-flex gap-2 tabular-nums text-ink">
                      <span className="font-medium">{n.format(m.outcomes[o] ?? 0)}</span>
                      <span className="text-ink-subtle">{share(m.outcomes[o] ?? 0)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
            <section className="card space-y-3">
              <h2 className="text-sm font-semibold text-ink">{t("monitoring.reviews")}</h2>
              <ul className="divide-y divide-line text-sm">
                {(["acknowledge", "dismiss", "defer"] as const).map((a) => (
                  <li key={a} className="flex items-center justify-between gap-3 py-2">
                    <span className="text-ink">{t(`runs.action.${a}`)}</span>
                    <span className="tabular-nums font-medium text-ink">{n.format(m.reviews[a])}</span>
                  </li>
                ))}
              </ul>
              <p className="hint">{reviewsTotal ? t("monitoring.reviewsHint") : t("monitoring.noReviews")}</p>
            </section>
            <CountTable title={t("monitoring.missingFields")} rows={m.missingInputs} empty={t("monitoring.none")} name={(k) => t(`fields.${k}`, { defaultValue: k })} />
            <CountTable
              title={t("monitoring.policyBlocks", { count: blocked })}
              rows={m.policyBlocks}
              empty={t("monitoring.none")}
              name={(k) => (
                <>
                  <span className="font-medium">{k}</span>
                  {ruleText(k) && <span className="text-ink-muted"> {ruleText(k)}</span>}
                </>
              )}
            />
            <CountTable title={t("monitoring.aiSteps")} rows={m.ai.byStatus} empty={t("monitoring.none")} name={(k) => t(`monitoring.aiStatus.${k}`, { defaultValue: k })} />
            <CountTable title={t("monitoring.departments")} rows={m.byDepartment.map((d) => ({ key: d.department ?? "", count: d.runs }))} empty={t("monitoring.none")} name={(k) => k || t("monitoring.noDepartment")} />
          </div>

          <section className="card p-0">
            <h2 className="px-4 pt-4 text-sm font-semibold text-ink sm:px-5">{t("monitoring.byAgent")}</h2>
            <div className="table-wrap mt-2">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t("inspector.agent")}</th>
                    <th className="hidden md:table-cell">{t("monitoring.department")}</th>
                    <th className="text-end">{t("monitoring.runs")}</th>
                    <th className="text-end">{t("runs.outcome.needs_input")}</th>
                    <th className="text-end">{t("runs.outcome.needs_review")}</th>
                    <th className="hidden text-end sm:table-cell">{t("monitoring.blockedRuns")}</th>
                    <th className="hidden text-end lg:table-cell">{t("monitoring.aiCalls")}</th>
                  </tr>
                </thead>
                <tbody>
                  {m.byAgent.map((a) => (
                    <tr key={a.agentId}>
                      <td>
                        <Link className="font-medium text-accent hover:underline" to={`/agents/${a.agentId}/runs`}>
                          {a.name}
                        </Link>
                      </td>
                      <td className="hidden text-ink-muted md:table-cell">{a.department ?? "–"}</td>
                      <td className="text-end tabular-nums">{n.format(a.runs)}</td>
                      <td className="text-end tabular-nums">{n.format(a.needsInput)}</td>
                      <td className="text-end tabular-nums">{n.format(a.needsReview)}</td>
                      <td className="hidden text-end tabular-nums sm:table-cell">{n.format(a.blocked)}</td>
                      <td className="hidden text-end tabular-nums lg:table-cell">{n.format(a.aiCalls)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
