/** Run Inspector: recent runs across agents (filters), and one run with every step and rule. */
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { AgentSummary, RunDetail, RunListItem } from "../api/client";
import { prefetch, useQuery } from "../api/query";
import { ErrorNote } from "../components/ErrorNote";
import { OUTCOME_TONE, RunResult, formatDate } from "../components/RunResult";
import { Field } from "../ui/Field";
import { PageHeader } from "../ui/PageHeader";
import { DetailSkeleton, TableSkeleton } from "../ui/Skeleton";
import { StatusPill } from "../ui/StatusPill";

const OUTCOMES = ["findings", "needs_review", "needs_input", "not_applicable", "blocked", "unavailable"];

export function RunInspector() {
  const { t, i18n } = useTranslation();
  const [f, setF] = useState({ agentId: "", outcome: "", purpose: "", caseRef: "" });
  const agentsQ = useQuery<{ agents: AgentSummary[] }>("/agents");
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v.trim()) as [string, string][]).toString();
  const runsQ = useQuery<{ runs: RunListItem[] }>(`/runs${qs ? `?${qs}` : ""}`);
  const runs = runsQ.data?.runs;

  return (
    <div className="space-y-6">
      <PageHeader title={t("inspector.title")} intro={t("inspector.intro")} />
      <ErrorNote error={runsQ.error} />
      <div className="card field-grid sm:grid-cols-2 lg:grid-cols-4">
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
        <Field label={t("runs.result")}>
          <select className="input" value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })}>
            <option value="">{t("inspector.all")}</option>
            {OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {t(`runs.outcome.${o}`)}
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
        <Field label={t("runs.caseRef")}>
          <input className="input" type="search" value={f.caseRef} onChange={(e) => setF({ ...f, caseRef: e.target.value })} />
        </Field>
      </div>

      {!runs ? (
        !runsQ.error && <TableSkeleton cols={5} />
      ) : runs.length === 0 ? (
        <p className="card text-sm text-ink-subtle">{t("inspector.empty")}</p>
      ) : (
        <div className="card p-0">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t("runs.caseRef")}</th>
                  <th>{t("inspector.agent")}</th>
                  <th>{t("runs.result")}</th>
                  <th className="hidden md:table-cell">{t("inspector.purpose")}</th>
                  <th className="hidden sm:table-cell">{t("runs.when")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.runId}>
                    <td className="font-medium text-ink">{r.caseRef}</td>
                    <td>
                      {r.agentName}
                      <div className="text-caption text-ink-subtle">{t("runs.candidateShort", { no: r.candidateNo })}</div>
                    </td>
                    <td>
                      <StatusPill tone={OUTCOME_TONE[r.outcome] ?? "neutral"}>{t(`runs.outcome.${r.outcome}`)}</StatusPill>
                    </td>
                    <td className="hidden text-ink-muted md:table-cell">{t(`inspector.purposes.${r.purpose}`)}</td>
                    <td className="hidden text-ink-muted sm:table-cell">{formatDate(r.createdAt, i18n.language)}</td>
                    <td className="text-end">
                      <Link className="btn btn-sm" to={`/runs/${r.runId}`} onMouseEnter={() => prefetch(`/runs/${r.runId}`)}>
                        {t("inspector.inspect")}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export function RunDetailPage() {
  const { t } = useTranslation();
  const { runId } = useParams();
  const q = useQuery<RunDetail>(`/runs/${runId}`);
  if (!q.data) return q.error ? <ErrorNote error={q.error} /> : <DetailSkeleton />;
  const run = q.data;
  return (
    <div className="space-y-6">
      <PageHeader back={{ to: "/runs", label: t("inspector.title") }} title={run.caseRef} meta={<span>{run.agentName}</span>} />
      <RunResult run={run} details />
    </div>
  );
}
