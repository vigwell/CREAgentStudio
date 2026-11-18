import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api, type Agent, type Candidate, type RunDetail, type RunSummary } from "../api/client";
import { ErrorNote } from "../components/ErrorNote";
import { StatusPill, type Tone } from "../ui/StatusPill";
import { fetchQuery, setQueryData, useQuery } from "../api/query";
import { DetailSkeleton } from "../ui/Skeleton";
import { Field } from "../ui/Field";
import { PageHeader } from "../ui/PageHeader";
import { findingTitle, stepNote } from "../ui/runText";
import { Check, FlaskConical, Play } from "lucide-react";

const FIELDS: { name: string; kind: "text" | "number" | "bool" | "sex" }[] = [
  { name: "indicationCode", kind: "text" },
  { name: "hasIndication", kind: "bool" },
  { name: "ageYears", kind: "number" },
  { name: "sex", kind: "sex" },
  { name: "egfr", kind: "number" },
  { name: "contrastAllergy", kind: "bool" },
  { name: "pregnant", kind: "bool" },
];

/** Only entered values are sent; an empty field stays "missing" (never false). */
export function manualValues(form: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of FIELDS) {
    const v = (form[f.name] ?? "").trim();
    if (!v) continue;
    out[f.name] = f.kind === "number" ? Number(v) : f.kind === "bool" ? v === "true" : v;
  }
  return out;
}

const OUTCOME_TONE: Record<string, Tone> = {
  findings: "success",
  needs_review: "warning",
  needs_input: "info",
  blocked: "danger",
  unavailable: "danger",
  not_applicable: "neutral",
};

export function AgentRuns() {
  const { t, i18n } = useTranslation();
  const { agentId } = useParams();
  const agentQ = useQuery<Agent>(`/agents/${agentId}`);
  const candQ = useQuery<{ candidates: Candidate[] }>(`/agents/${agentId}/candidates`);
  const runsQ = useQuery<{ runs: RunSummary[] }>(`/agents/${agentId}/runs`);
  const agent = agentQ.data ?? null;
  const candidates = candQ.data?.candidates ?? [];
  const runs = runsQ.data?.runs ?? [];
  const [candidateId, setCandidateId] = useState("");
  const [caseRef, setCaseRef] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [form, setForm] = useState<Record<string, string>>({});
  const [run, setRun] = useState<RunDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const loadRuns = () => runsQ.refetch();
  useEffect(() => {
    if (!candidateId && candidates[0]) setCandidateId(candidates[0].id);
  }, [candidates, candidateId]);
  const [opening, setOpening] = useState<string | null>(null);
  const openRun = async (runId: string) => {
    setOpening(runId);
    try {
      setRun(await fetchQuery<RunDetail>(`/runs/${runId}`));
    } catch (err) {
      setError(err);
    } finally {
      setOpening(null);
    }
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const key = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now());
      const body = { agentId, candidateId, caseRef: caseRef.trim(), deviceId: deviceId.trim() || null, inputs: { manualValues: manualValues(form) } };
      const res = await api<RunDetail>("/runs", { body, headers: { "Idempotency-Key": key } });
      setRun(res);
      setQueryData(`/runs/${res.runId}`, res);
      await loadRuns();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const [reasonFor, setReasonFor] = useState<{ index: number; action: string } | null>(null);
  const [reasonText, setReasonText] = useState("");
  const review = async (index: number, action: string, reason: string | null = null) => {
    if (!run) return;
    if (action !== "acknowledge" && !reason) {
      setReasonFor({ index, action });
      setReasonText("");
      return;
    }
    try {
      await api(`/runs/${run.runId}/reviews`, { body: { findingIndex: index, action, reason, snapshotHash: run.snapshotHash } });
      setReasonFor(null);
      setRun(await fetchQuery<RunDetail>(`/runs/${run.runId}`));
    } catch (err) {
      setError(err);
    }
  };

  if (!agent) return error || agentQ.error ? <ErrorNote error={error ?? agentQ.error} /> : <DetailSkeleton />;

  const candidateLabel = (c: Candidate) => t("runs.candidateOption", { no: c.candidateNo, date: formatDate(c.createdAt, i18n.language) });

  return (
    <div className="space-y-6">
      <PageHeader back={{ to: `/agents/${agent.id}`, label: agent.name }} title={t("runs.title")} intro={t("runs.intro")} />
      <ErrorNote error={error ?? candQ.error ?? runsQ.error} />

      {agent.kind !== "cds" ? (
        <p className="text-ink-subtle">{t("runs.voiceLater")}</p>
      ) : candQ.isLoading ? (
        <DetailSkeleton />
      ) : candidates.length === 0 ? (
        candQ.error ? null : <p className="text-ink-subtle">{t("runs.noCandidate")}</p>
      ) : (
        <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,400px)_minmax(0,1fr)]">
          <form
            className="card space-y-6 xl:sticky xl:top-20"
            onSubmit={(e) => {
              e.preventDefault();
              void start();
            }}
          >
            <section className="space-y-4">
              <h2 className="text-sm font-semibold text-ink">{t("runs.caseSection")}</h2>
              <div className="field-grid sm:grid-cols-2 xl:grid-cols-1">
                <Field label={t("runs.candidate")}>
                  <select className="input" value={candidateId} onChange={(e) => setCandidateId(e.target.value)}>
                    {candidates.map((c) => (
                      <option key={c.id} value={c.id}>
                        {candidateLabel(c)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t("runs.caseRef")}>
                  <input className="input" value={caseRef} onChange={(e) => setCaseRef(e.target.value)} placeholder="DEMO-CASE-201" />
                </Field>
                <Field label={t("runs.device")}>
                  <input className="input" value={deviceId} onChange={(e) => setDeviceId(e.target.value)} placeholder="CT-01" />
                </Field>
              </div>
            </section>
            <section className="space-y-4 border-t border-line pt-5">
              <div>
                <h2 className="text-sm font-semibold text-ink">{t("runs.patientSection")}</h2>
                <p className="mt-1 text-caption text-ink-subtle">{t("runs.patientHint")}</p>
              </div>
              <div className="field-grid sm:grid-cols-2">
                {FIELDS.map((f) => (
                  <Field key={f.name} label={t(`fields.${f.name}`)}>
                    {f.kind === "bool" || f.kind === "sex" ? (
                      <select className="input" value={form[f.name] ?? ""} onChange={(e) => setForm({ ...form, [f.name]: e.target.value })}>
                        <option value="">{t("runs.notGiven")}</option>
                        {(f.kind === "bool" ? ["true", "false"] : ["female", "male", "unknown"]).map((v) => (
                          <option key={v} value={v}>
                            {t(`values.${v}`)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className="input"
                        type={f.kind === "number" ? "number" : "text"}
                        inputMode={f.kind === "number" ? "decimal" : undefined}
                        value={form[f.name] ?? ""}
                        onChange={(e) => setForm({ ...form, [f.name]: e.target.value })}
                      />
                    )}
                  </Field>
                ))}
              </div>
            </section>
            <div className="flex justify-end border-t border-line pt-5">
              <button type="submit" className="btn btn-primary" disabled={busy || !caseRef.trim() || !candidateId}>
                <Play size={16} />
                {busy ? t("runs.running") : t("runs.run")}
              </button>
            </div>
          </form>

          <div className="min-w-0 space-y-6">
            {run ? (
              <RunResult
                run={run}
                reasonFor={reasonFor}
                reasonText={reasonText}
                setReasonText={setReasonText}
                onCancelReason={() => setReasonFor(null)}
                onReview={(i, a, r) => void review(i, a, r)}
              />
            ) : (
              <div className="card flex min-h-[220px] flex-col items-center justify-center gap-2 text-center">
                <FlaskConical size={22} className="text-ink-subtle" />
                <p className="max-w-sm text-sm text-ink-muted">{t("runs.emptyResult")}</p>
              </div>
            )}

            {runs.length > 0 && (
              <section className="card p-0">
                <h2 className="border-b border-line px-4 py-3 text-sm font-semibold text-ink">{t("runs.history")}</h2>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>{t("runs.caseRef")}</th>
                        <th>{t("runs.candidate")}</th>
                        <th>{t("runs.result")}</th>
                        <th className="hidden sm:table-cell">{t("runs.when")}</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {runs.map((r) => (
                        <tr key={r.runId} className={run?.runId === r.runId ? "bg-accent-soft/50" : ""}>
                          <td className="font-medium">{r.caseRef}</td>
                          <td>{r.candidateNo}</td>
                          <td>
                            <StatusPill tone={OUTCOME_TONE[r.outcome] ?? "neutral"}>{t(`runs.outcome.${r.outcome}`)}</StatusPill>
                          </td>
                          <td className="hidden text-ink-muted sm:table-cell">{formatDate(r.createdAt, i18n.language)}</td>
                          <td className="text-end">
                            <button className="btn btn-sm" disabled={opening === r.runId} onClick={() => void openRun(r.runId)}>
                              {t("agents.open")}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function formatDate(iso: string, lang: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(lang, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(d);
}

const SEVERITY_TONE: Record<string, Tone> = { info: "info", review: "warning", warning: "warning", critical: "danger" };
const STEP_TONE: Record<string, Tone> = {
  completed: "success",
  skipped: "neutral",
  not_reached: "neutral",
  awaiting_input: "info",
  blocked: "danger",
  failed: "danger",
};

/** Present a value a clinician can read: yes / no, numbers, codes. */
function useValueText() {
  const { t } = useTranslation();
  return (v: unknown) => (v === true ? t("values.true") : v === false ? t("values.false") : v === null || v === undefined ? t("runs.notGiven") : String(v));
}

function RunResult({
  run,
  reasonFor,
  reasonText,
  setReasonText,
  onCancelReason,
  onReview,
}: {
  run: RunDetail;
  reasonFor: { index: number; action: string } | null;
  reasonText: string;
  setReasonText: (s: string) => void;
  onCancelReason: () => void;
  onReview: (index: number, action: string, reason?: string | null) => void;
}) {
  const { t, i18n } = useTranslation();
  const valueText = useValueText();
  const fieldName = (f: string) => t(`fields.${f}`, { defaultValue: f });
  return (
    <section key={run.runId} className="card space-y-6">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-title font-semibold text-ink">{t("runs.resultFor", { caseRef: run.caseRef })}</h2>
          <p className="mt-0.5 text-sm text-ink-muted">{t("runs.resultMeta", { no: run.candidateNo, date: formatDate(run.createdAt, i18n.language) })}</p>
        </div>
        <StatusPill tone={OUTCOME_TONE[run.outcome] ?? "neutral"}>{t(`runs.outcome.${run.outcome}`)}</StatusPill>
      </div>

      {run.missingInputs.length > 0 && (
        <div className="rounded-control border border-info/30 bg-info-soft px-4 py-3 text-sm text-info">
          {t("runs.missingText", { fields: run.missingInputs.map(fieldName).join(", ") })}
        </div>
      )}

      {run.findings.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-ink">{t("runs.findingsTitle", { count: run.findings.length })}</h3>
          {run.findings.map((f, i) => {
            const reviewed = run.reviews.filter((r) => r.findingIndex === i);
            const asking = reasonFor?.index === i ? reasonFor.action : null;
            return (
              <article key={i} className="rounded-panel border border-line">
                <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="font-medium text-ink">{findingTitle(t, f)}</h4>
                      <StatusPill tone={SEVERITY_TONE[f.severity] ?? "neutral"}>{t(`runs.severity.${f.severity}`)}</StatusPill>
                    </div>
                    {f.detail && <p className="mt-1 text-sm text-ink-muted">{f.detail}</p>}
                  </div>
                  {reviewed.length === 0 && !asking && (
                    <div className="flex shrink-0 flex-wrap gap-2">
                      {f.allowedActions.map((a) => (
                        <button key={a} className={`btn btn-sm ${a === "acknowledge" ? "btn-primary" : ""}`} onClick={() => onReview(i, a)}>
                          {t(`runs.action.${a}`)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {asking && (
                  <form
                    className="flex flex-col gap-2 border-t border-line bg-surface-sunken/40 p-4 sm:flex-row sm:items-end"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (reasonText.trim()) onReview(i, asking, reasonText.trim());
                    }}
                  >
                    <Field className="flex-1" label={t("runs.reasonFor", { action: t(`runs.action.${asking}`) })}>
                      <input className="input" autoFocus value={reasonText} onChange={(e) => setReasonText(e.target.value)} />
                    </Field>
                    <div className="flex gap-2">
                      <button type="button" className="btn" onClick={onCancelReason}>
                        {t("agents.cancel")}
                      </button>
                      <button type="submit" className="btn btn-primary" disabled={!reasonText.trim()}>
                        {t(`runs.action.${asking}`)}
                      </button>
                    </div>
                  </form>
                )}

                {(f.observedInputs.length > 0 || f.evidence.length > 0) && (
                  <dl className="grid grid-cols-1 gap-4 border-t border-line p-4 text-sm sm:grid-cols-2">
                    {f.observedInputs.length > 0 && (
                      <div>
                        <dt className="label">{t("runs.observed")}</dt>
                        {f.observedInputs.map((o) => (
                          <dd key={o.field} className="flex flex-wrap gap-x-2">
                            <span className="text-ink-muted">{fieldName(o.field)}:</span>
                            <span className="font-medium text-ink">{valueText(o.value)}</span>
                            <span className="text-ink-subtle">({o.attribution.startsWith("manual") ? t("runs.enteredManually") : t("runs.fromSource")})</span>
                          </dd>
                        ))}
                      </div>
                    )}
                    {f.evidence.length > 0 && (
                      <div>
                        <dt className="label">{t("runs.evidence")}</dt>
                        {f.evidence.map((e) => (
                          <dd key={e.rowId}>
                            <Link className="font-medium text-accent hover:underline" to={`/knowledge/revisions/${e.knowledgeRevisionId}`}>
                              {e.sourceName}
                            </Link>
                            <span className="text-ink-muted"> {t("runs.rowRef", { sheet: e.sheet ?? "", row: e.sourceRow })}</span>
                          </dd>
                        ))}
                      </div>
                    )}
                  </dl>
                )}

                {reviewed.length > 0 && (
                  <div className="flex items-center gap-2 border-t border-line px-4 py-3 text-sm text-success">
                    <Check size={16} />
                    {reviewed.map((r) => t(`runs.reviewed.${r.action}`) + (r.reason ? `: ${r.reason}` : "")).join("; ")}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      {run.blockedFindings.length > 0 && (
        <p className="text-sm text-danger">{t("runs.blockedText", { count: run.blockedFindings.length, rules: [...new Set(run.blockedFindings.flatMap((b) => b.ruleIds))].join(", ") })}</p>
      )}

      {run.summary && (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-ink">{t("runs.summary")}</h3>
          {run.summary.ai === "not_configured" ? (
            <ul className="list-disc space-y-1 rounded-control bg-surface-sunken py-3 pe-4 ps-8 text-sm text-ink">
              {run.findings.length ? run.findings.map((f, i) => <li key={i}>{findingTitle(t, f)}</li>) : <li className="list-none">{t("runs.noFindings")}</li>}
            </ul>
          ) : (
            <p className="whitespace-pre-line rounded-control bg-surface-sunken px-4 py-3 text-sm text-ink">{run.summary.text}</p>
          )}
          {run.summary.ai === "not_configured" && <p className="hint">{t("runs.aiNotConfigured")}</p>}
        </div>
      )}

      <div>
        <h3 className="mb-3 text-sm font-semibold text-ink">{t("runs.trace")}</h3>
        <ol className="space-y-0">
          {run.trace.map((n, i) => (
            <li key={n.nodeId} className="relative flex gap-3 pb-4 last:pb-0">
              {i < run.trace.length - 1 && <span aria-hidden className="absolute start-[11px] top-6 h-[calc(100%-12px)] w-px bg-line" />}
              <span
                aria-hidden
                className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-caption font-medium ${
                  n.state === "completed" ? "border-success/40 bg-success-soft text-success" : n.state === "awaiting_input" ? "border-info/40 bg-info-soft text-info" : n.state === "blocked" || n.state === "failed" ? "border-danger/40 bg-danger-soft text-danger" : "border-line bg-surface text-ink-subtle"
                }`}
              >
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`font-medium ${n.state === "skipped" || n.state === "not_reached" ? "text-ink-subtle" : "text-ink"}`}>{n.label}</span>
                  <StatusPill tone={STEP_TONE[n.state] ?? "neutral"}>{t(`runs.step.${n.state}`)}</StatusPill>
                  {n.port && n.port !== "unknown" && <span className="text-sm text-ink-muted">{t("runs.tookBranch", { branch: t(`values.${n.port}`) })}</span>}
                </div>
                {stepNote(t, n) && <p className="mt-0.5 text-sm text-ink-muted">{stepNote(t, n)}</p>}
                {n.unknown.length > 0 && <p className="mt-0.5 text-sm text-ink-subtle">{t("runs.unknownValues", { fields: n.unknown.map(fieldName).join(", ") })}</p>}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
