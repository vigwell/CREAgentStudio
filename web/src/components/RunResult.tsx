/** A run's result: findings with evidence, review actions, summary and the numbered steps. */
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import type { RunDetail } from "../api/client";
import { StatusPill, type Tone } from "../ui/StatusPill";
import { Field } from "../ui/Field";
import { findingTitle, stepNote } from "../ui/runText";

export const FIELDS: { name: string; kind: "text" | "number" | "bool" | "sex" | "note" }[] = [
  { name: "indicationCode", kind: "text" },
  { name: "hasIndication", kind: "bool" },
  { name: "ageYears", kind: "number" },
  { name: "sex", kind: "sex" },
  { name: "egfr", kind: "number" },
  { name: "contrastAllergy", kind: "bool" },
  { name: "pregnant", kind: "bool" },
  { name: "pediatric", kind: "bool" },
  { name: "clinicalNote", kind: "note" },
  // ACR decision support: the other referral categories (as on CRE's ACR screen).
  { name: "priors", kind: "note" },
  { name: "labs", kind: "note" },
  { name: "diagnoses", kind: "note" },
];

export const OUTCOME_TONE: Record<string, Tone> = {
  findings: "success",
  needs_review: "warning",
  needs_input: "info",
  blocked: "danger",
  unavailable: "danger",
  not_applicable: "neutral",
};

export function formatDate(iso: string, lang: string): string {
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

export function RunResult({
  run,
  reasonFor = null,
  reasonText = "",
  setReasonText = () => {},
  onCancelReason = () => {},
  onReview,
  details = false,
}: {
  run: RunDetail;
  reasonFor?: { index: number; action: string } | null;
  reasonText?: string;
  setReasonText?: (s: string) => void;
  onCancelReason?: () => void;
  /** Omitted: read-only (no review buttons). */
  onReview?: (index: number, action: string, reason?: string | null) => void;
  /** Run Inspector: versions, snapshot and the evaluated rules. */
  details?: boolean;
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
                    {f.detail && (
                      <p className="mt-1 whitespace-pre-line text-sm text-ink-muted" dir="auto">
                        {f.detail}
                      </p>
                    )}
                    {f.details && f.details.length > 0 && (
                      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
                        {f.details.map((d) => (
                          <div key={d.label} className="contents">
                            <dt className="text-ink-muted">{fieldName(d.label)}</dt>
                            <dd className="text-ink">
                              <bdi>{d.value}</bdi>
                            </dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </div>
                  {onReview && reviewed.length === 0 && !asking && (
                    <div className="flex shrink-0 flex-wrap gap-2">
                      {f.allowedActions.map((a) => (
                        <button key={a} className={`btn btn-sm ${a === "acknowledge" ? "btn-primary" : ""}`} onClick={() => onReview?.(i, a)}>
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
                      if (reasonText.trim()) onReview?.(i, asking, reasonText.trim());
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
                            <span className="text-ink-subtle">
                              ({o.attribution === "ai" ? t("runs.fromNoteByAi") : o.attribution.startsWith("manual") ? t("runs.enteredManually") : t("runs.fromSource")})
                            </span>
                            {o.quote && (
                              <q className="basis-full text-ink-muted" dir="auto">
                                {o.quote}
                              </q>
                            )}
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
          {run.summary.ai !== "used" ? (
            <ul className="list-disc space-y-1 rounded-control bg-surface-sunken py-3 pe-4 ps-8 text-sm text-ink">
              {run.findings.length ? run.findings.map((f, i) => <li key={i}>{findingTitle(t, f)}</li>) : <li className="list-none">{t("runs.noFindings")}</li>}
            </ul>
          ) : (
            <p className="whitespace-pre-line rounded-control bg-surface-sunken px-4 py-3 text-sm text-ink" dir="auto">
              {run.summary.text}
            </p>
          )}
          <p className="hint">{t(`runs.summaryAi.${run.summary.ai}`, { defaultValue: "" })}</p>
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
                {n.evaluated && (
                  <p className="mt-0.5 text-sm text-ink-muted">
                    {t("runs.rule", {
                      field: fieldName(n.evaluated.field),
                      op: t(`ops.${n.evaluated.operator}`, { defaultValue: n.evaluated.operator }),
                      expected: n.evaluated.operator === "exists" ? "" : valueText(n.evaluated.expected),
                      actual: n.evaluated.actual === null ? t("runs.unknown") : valueText(n.evaluated.actual),
                    }).replace(/\s+([:,.])/g, "$1")}
                  </p>
                )}
                {stepNote(t, n) && <p className="mt-0.5 text-sm text-ink-muted">{stepNote(t, n)}</p>}
                {n.ai?.answer && (
                  <details className="mt-1 text-sm">
                    <summary className="cursor-pointer text-ink-muted">{t("runs.aiAnswer")}</summary>
                    <p className="mt-1 whitespace-pre-line rounded-control bg-surface-sunken px-3 py-2 text-ink" dir="auto">
                      {n.ai.answer}
                    </p>
                  </details>
                )}
                {n.unknown.length > 0 && <p className="mt-0.5 text-sm text-ink-subtle">{t("runs.unknownValues", { fields: n.unknown.map(fieldName).join(", ") })}</p>}
              </div>
            </li>
          ))}
        </ol>
      </div>

      {details && (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 border-t border-line pt-5 text-sm sm:grid-cols-2">
          <div>
            <dt className="label">{t("inspector.purpose")}</dt>
            <dd>{t(`inspector.purposes.${run.purpose}`, { defaultValue: run.purpose })}</dd>
          </div>
          <div>
            <dt className="label">{t("inspector.version")}</dt>
            <dd>{t("runs.candidateShort", { no: run.candidateNo })}</dd>
          </div>
          <div className="min-w-0">
            <dt className="label">{t("editor.hash")}</dt>
            <dd className="truncate text-ink-muted" dir="ltr" title={run.manifestHash}>{run.manifestHash}</dd>
          </div>
          <div className="min-w-0">
            <dt className="label">{t("inspector.snapshot")}</dt>
            <dd className="truncate text-ink-muted" dir="ltr" title={run.snapshotHash}>{run.snapshotHash}</dd>
          </div>
        </dl>
      )}
    </section>
  );
}
