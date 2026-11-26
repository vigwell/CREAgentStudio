import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api, type Agent, type Candidate, type RunDetail, type RunSummary } from "../api/client";
import { ErrorNote } from "../components/ErrorNote";
import { StatusPill } from "../ui/StatusPill";
import { FIELDS, OUTCOME_TONE, RunResult, formatDate } from "../components/RunResult";
import { NOTE_MAX, ScanReader } from "../components/ScanReader";
import { fetchQuery, invalidate, setQueryData, useQuery } from "../api/query";
import { DetailSkeleton } from "../ui/Skeleton";
import { Field } from "../ui/Field";
import { PageHeader } from "../ui/PageHeader";
import { FlaskConical, Play } from "lucide-react";


/** Only entered values are sent; an empty field stays "missing" (never false). */
export function manualValues(form: Record<string, string>, only?: string[] | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of FIELDS) {
    if (only && !only.includes(f.name)) continue;
    const v = (form[f.name] ?? "").trim();
    if (!v) continue;
    out[f.name] = f.kind === "number" ? Number(v) : f.kind === "bool" ? v === "true" : v;
  }
  return out;
}


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
  // Inputs this version reads (MRI agents: referral, age, pediatric); null = all.
  const shownFields = candidates.find((c) => c.id === candidateId)?.inputFields ?? null;
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
  const [savedCase, setSavedCase] = useState<string | null>(null);
  const [savingCase, setSavingCase] = useState(false);
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
      const body = { agentId, candidateId, caseRef: caseRef.trim(), deviceId: deviceId.trim() || null, inputs: { manualValues: manualValues(form, shownFields) } };
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

  /** This run's inputs and result become a saved test case (expected = what happened now). */
  const saveAsCase = async (r: RunDetail) => {
    setSavingCase(true);
    try {
      const values = Object.fromEntries(
        Object.entries(r.snapshot?.facts ?? {})
          .filter(([, f]) => f.status === "present")
          .map(([k, f]) => [k, f.value]),
      );
      const path = r.trace
        .filter((n) => n.type === "decision" && (n.port === "yes" || n.port === "no" || n.state === "awaiting_input"))
        .map((n) => (n.state === "awaiting_input" ? { nodeId: n.nodeId, state: "awaiting_input" } : { nodeId: n.nodeId, state: "completed", port: n.port }));
      await api(`/agents/${agentId}/test-cases`, {
        body: {
          name: r.caseRef,
          inputs: { manualValues: values },
          expected: { outcome: r.outcome, findingCodes: r.findings.map((f) => f.code), ...(path.length ? { path } : {}) },
        },
      });
      invalidate(`/agents/${agentId}/test-cases`);
      setSavedCase(r.runId);
    } catch (err) {
      setError(err);
    } finally {
      setSavingCase(false);
    }
  };

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
                {FIELDS.filter((f) => !shownFields || shownFields.includes(f.name)).map((f) => (
                  <Field key={f.name} label={t(`fields.${f.name}`)} hint={f.kind === "note" ? t(f.name === "clinicalNote" ? "runs.noteHint" : "runs.contextHint") : undefined} className={f.kind === "note" ? "sm:col-span-2" : ""}>
                    {f.kind === "note" ? (
                      <div className="space-y-2">
                        <textarea
                          className="input min-h-28"
                          dir="auto"
                          maxLength={NOTE_MAX}
                          value={form[f.name] ?? ""}
                          onChange={(e) => setForm({ ...form, [f.name]: e.target.value })}
                        />
                        <ScanReader onText={(text) => setForm((cur) => ({ ...cur, [f.name]: text }))} />
                      </div>
                    ) : f.kind === "bool" || f.kind === "sex" ? (
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
            {run && agent.kind === "cds" && (
              <div className="flex flex-wrap items-center justify-end gap-3">
                {savedCase === run.runId ? (
                  <span className="text-sm text-success">
                    {t("release.savedAsCase")}{" "}
                    <Link className="font-medium underline" to={`/agents/${agent.id}/release`}>
                      {t("release.short")}
                    </Link>
                  </span>
                ) : (
                  <button className="btn btn-sm" disabled={savingCase} onClick={() => void saveAsCase(run)}>
                    {t("release.saveAsCase")}
                  </button>
                )}
              </div>
            )}
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
