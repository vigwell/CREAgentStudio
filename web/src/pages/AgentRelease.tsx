/**
 * Versions and release: saved test cases, tests on a frozen candidate, the
 * semantic diff against the active version, independent approval, activation,
 * rollback and withdrawal (draft → candidate → tests passed → approved → active).
 */
import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { api, type Agent, type AgentVersion, type Expected, type StudioUser, type TestCase, type TestRun, type VersionDiff } from "../api/client";
import { invalidate, useQuery } from "../api/query";
import { ErrorNote } from "../components/ErrorNote";
import { FIELDS, OUTCOME_TONE, formatDate } from "../components/RunResult";
import { manualValues } from "./AgentRuns";
import { Field } from "../ui/Field";
import { PageHeader } from "../ui/PageHeader";
import { DetailSkeleton } from "../ui/Skeleton";
import { StatusPill, type Tone } from "../ui/StatusPill";

const OUTCOMES = ["findings", "needs_review", "needs_input", "not_applicable", "blocked", "unavailable"];
const FINDING_CODES = ["PROTOCOL_MATCH_REVIEW", "PROTOCOL_CONFLICT", "PROTOCOL_NO_MATCH", "GUIDANCE_MATCH_REVIEW", "GUIDANCE_CONFLICT", "GUIDANCE_NO_MATCH", "INSTRUCTION", "MISSING_INPUT"];
const STATUS_TONE: Record<string, Tone> = { candidate: "neutral", approved: "info", active: "success", retired: "neutral", withdrawn: "danger" };

type Form = { id?: string; version?: number; name: string; values: Record<string, string>; outcome: string; codes: string[]; branches: Record<string, string> };
const EMPTY: Form = { name: "", values: {}, outcome: "findings", codes: [], branches: {} };

export function AgentRelease({ user }: { user: StudioUser }) {
  const { t, i18n } = useTranslation();
  const { agentId } = useParams();
  const agentQ = useQuery<Agent>(`/agents/${agentId}`);
  const versionsQ = useQuery<{ versions: AgentVersion[] }>(`/agents/${agentId}/versions`);
  const casesQ = useQuery<{ testCases: TestCase[] }>(`/agents/${agentId}/test-cases`);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<{ id: string; tab: "tests" | "diff" } | null>(null);
  const [testRuns, setTestRuns] = useState<Record<string, TestRun>>({});
  const [diffs, setDiffs] = useState<Record<string, VersionDiff>>({});
  const [withdrawing, setWithdrawing] = useState<{ id: string; reason: string } | null>(null);
  const [form, setForm] = useState<Form | null>(null);

  const agent = agentQ.data;
  const versions = versionsQ.data?.versions ?? [];
  const cases = casesQ.data?.testCases ?? [];
  const canAuthor = user.role !== "viewer";
  const canApprove = user.role === "admin" || user.role === "approver";
  const decisions = useMemo(() => (agent?.draft.graph.nodes ?? []).filter((n) => n.type === "decision"), [agent]);
  const nodeLabel = (id: string) => agent?.draft.graph.nodes.find((n) => n.id === id)?.label ?? id;

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      invalidate(`/agents/${agentId}/versions`);
      invalidate(`/agents/${agentId}/candidates`);
      invalidate("/agents");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  const runTests = (v: AgentVersion) =>
    act(`tests-${v.id}`, async () => {
      const r = await api<TestRun>(`/candidates/${v.id}/tests`, { method: "POST" });
      setTestRuns((m) => ({ ...m, [v.id]: r }));
      setOpen({ id: v.id, tab: "tests" });
    });
  const showTests = async (v: AgentVersion) => {
    setOpen({ id: v.id, tab: "tests" });
    if (testRuns[v.id]) return;
    try {
      const r = await api<{ testRun: TestRun | null }>(`/candidates/${v.id}/tests`);
      if (r.testRun) setTestRuns((m) => ({ ...m, [v.id]: r.testRun! }));
    } catch (err) {
      setError(err);
    }
  };
  const showDiff = async (v: AgentVersion) => {
    setOpen({ id: v.id, tab: "diff" });
    if (diffs[v.id]) return;
    try {
      const d = await api<VersionDiff>(`/candidates/${v.id}/diff`);
      setDiffs((m) => ({ ...m, [v.id]: d }));
    } catch (err) {
      setError(err);
    }
  };

  const saveCase = async () => {
    if (!form) return;
    const path = Object.entries(form.branches)
      .filter(([, b]) => b)
      .map(([nodeId, b]) => (b === "awaiting_input" ? { nodeId, state: "awaiting_input" } : { nodeId, state: "completed", port: b }));
    const expected: Expected = { outcome: form.outcome, ...(form.codes.length ? { findingCodes: form.codes } : {}), ...(path.length ? { path } : {}) };
    const body = { name: form.name, inputs: { manualValues: manualValues(form.values) }, expected, version: form.version };
    await act("case", async () => {
      if (form.id) await api(`/agents/${agentId}/test-cases/${form.id}`, { method: "PUT", body });
      else await api(`/agents/${agentId}/test-cases`, { body });
      await casesQ.refetch();
      setForm(null);
    });
  };
  const editCase = (c: TestCase) =>
    setForm({
      id: c.id,
      version: c.version,
      name: c.name,
      values: Object.fromEntries(Object.entries(c.inputs.manualValues).map(([k, v]) => [k, String(v)])),
      outcome: c.expected.outcome,
      codes: c.expected.findingCodes ?? [],
      branches: Object.fromEntries((c.expected.path ?? []).map((p) => [p.nodeId, p.state === "awaiting_input" ? "awaiting_input" : (p.port ?? "")])),
    });

  if (!agent) return agentQ.error ? <ErrorNote error={agentQ.error} /> : <DetailSkeleton />;
  if (agent.kind !== "cds")
    return (
      <div className="space-y-6">
        <PageHeader back={{ to: `/agents/${agent.id}`, label: agent.name }} title={t("release.title")} />
        <p className="text-ink-subtle">{t("release.voiceLater")}</p>
      </div>
    );

  const testStatus = (v: AgentVersion) =>
    !v.lastTest ? (
      <span className="text-ink-subtle">{t("release.notTested")}</span>
    ) : v.lastTest.passed ? (
      <StatusPill tone="success">{t("release.testsPassed", { count: v.lastTest.caseCount })}</StatusPill>
    ) : (
      <StatusPill tone="danger">{t("release.testsFailed", { failed: v.lastTest.failedCount, count: v.lastTest.caseCount })}</StatusPill>
    );

  return (
    <div className="space-y-8">
      <PageHeader back={{ to: `/agents/${agent.id}`, label: agent.name }} title={t("release.title")} intro={t("release.intro")} />
      <ErrorNote error={error ?? versionsQ.error ?? casesQ.error} />

      {/* ------------------------------------------------------------ versions */}
      <section className="card p-0">
        <h2 className="border-b border-line px-4 py-3 text-sm font-semibold text-ink">{t("release.versions")}</h2>
        {versionsQ.isLoading ? (
          <div className="p-4">
            <DetailSkeleton />
          </div>
        ) : versions.length === 0 ? (
          <p className="px-4 py-6 text-sm text-ink-subtle">{t("release.noVersions")}</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t("release.version")}</th>
                  <th>{t("release.status")}</th>
                  <th>{t("release.tests")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => {
                  const mine = v.createdBy === user.id;
                  const testsOk = !!v.lastTest?.passed;
                  return (
                    <tr key={v.id} className={open?.id === v.id ? "bg-accent-soft/40" : ""}>
                      <td>
                        <div className="font-medium text-ink">{t("runs.candidateShort", { no: v.candidateNo })}</div>
                        <div className="text-caption text-ink-subtle">{formatDate(v.createdAt, i18n.language)}</div>
                      </td>
                      <td>
                        <StatusPill tone={STATUS_TONE[v.status] ?? "neutral"}>{t(`release.statuses.${v.status}`)}</StatusPill>
                        {v.statusReason && <div className="mt-1 text-caption text-ink-subtle">{v.statusReason}</div>}
                      </td>
                      <td>{testStatus(v)}</td>
                      <td>
                        <div className="flex flex-wrap justify-end gap-2">
                          {v.status === "candidate" && canAuthor && (
                            <button className="btn btn-sm" disabled={busy === `tests-${v.id}`} onClick={() => void runTests(v)}>
                              {busy === `tests-${v.id}` ? t("release.testing") : t("release.runTests")}
                            </button>
                          )}
                          {v.lastTest && (
                            <button className="btn btn-sm" onClick={() => void showTests(v)}>
                              {t("release.results")}
                            </button>
                          )}
                          <button className="btn btn-sm" onClick={() => void showDiff(v)}>
                            {t("release.changes")}
                          </button>
                          {v.status === "candidate" && canApprove && (
                            <button
                              className="btn btn-sm btn-primary"
                              disabled={mine || !testsOk || busy === `approve-${v.id}`}
                              title={mine ? t("release.notOwn") : !testsOk ? t("release.needTests") : undefined}
                              onClick={() => void act(`approve-${v.id}`, () => api(`/candidates/${v.id}/approve`, { method: "POST" }))}
                            >
                              {t("release.approve")}
                            </button>
                          )}
                          {(v.status === "approved" || v.status === "retired") && canApprove && (
                            <button
                              className="btn btn-sm btn-primary"
                              disabled={busy === `activate-${v.id}`}
                              onClick={() => void act(`activate-${v.id}`, () => api(`/candidates/${v.id}/activate`, { method: "POST" }))}
                            >
                              {v.status === "retired" ? t("release.rollback") : t("release.activate")}
                            </button>
                          )}
                          {v.status !== "withdrawn" && canApprove && (
                            <button className="btn btn-sm btn-danger" onClick={() => setWithdrawing({ id: v.id, reason: "" })}>
                              {t("release.withdraw")}
                            </button>
                          )}
                        </div>
                        {withdrawing?.id === v.id && (
                          <form
                            className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end"
                            onSubmit={(e) => {
                              e.preventDefault();
                              const reason = withdrawing.reason.trim();
                              if (!reason) return;
                              void act(`withdraw-${v.id}`, async () => {
                                await api(`/candidates/${v.id}/withdraw`, { body: { reason } });
                                setWithdrawing(null);
                              });
                            }}
                          >
                            <Field className="flex-1" label={t("release.withdrawReason")}>
                              <input className="input" autoFocus value={withdrawing.reason} onChange={(e) => setWithdrawing({ id: v.id, reason: e.target.value })} />
                            </Field>
                            <div className="flex gap-2">
                              <button type="button" className="btn" onClick={() => setWithdrawing(null)}>
                                {t("agents.cancel")}
                              </button>
                              <button type="submit" className="btn btn-danger" disabled={!withdrawing.reason.trim()}>
                                {t("release.withdraw")}
                              </button>
                            </div>
                          </form>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {open && (
          <div className="border-t border-line p-4">
            <div className="mb-3 flex items-center gap-2">
              <h3 className="text-sm font-semibold text-ink">
                {open.tab === "tests" ? t("release.resultsFor", { no: versions.find((v) => v.id === open.id)?.candidateNo }) : t("release.changesFor", { no: versions.find((v) => v.id === open.id)?.candidateNo })}
              </h3>
              <button className="icon-btn ms-auto h-8 w-8" aria-label={t("nav.close")} onClick={() => setOpen(null)}>
                <X size={16} />
              </button>
            </div>
            {open.tab === "tests" ? (
              <TestResults run={testRuns[open.id]} nodeLabel={nodeLabel} />
            ) : (
              <DiffView diff={diffs[open.id]} />
            )}
          </div>
        )}
      </section>

      {/* ------------------------------------------------------------ test cases */}
      <section className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <div className="flex-1">
            <h2 className="text-title font-semibold text-ink">{t("release.testCases")}</h2>
            <p className="page-intro">{t("release.testCasesIntro")}</p>
          </div>
          {canAuthor && !form && (
            <button className="btn btn-primary self-start" onClick={() => setForm({ ...EMPTY })}>
              <Plus size={16} />
              {t("release.addCase")}
            </button>
          )}
        </div>

        {form && (
          <form
            className="card space-y-6"
            onSubmit={(e) => {
              e.preventDefault();
              void saveCase();
            }}
          >
            <Field label={t("release.caseName")}>
              <input className="input" autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <section className="space-y-3 border-t border-line pt-5">
              <h3 className="text-sm font-semibold text-ink">{t("runs.patientSection")}</h3>
              <div className="field-grid sm:grid-cols-2 lg:grid-cols-4">
                {/* Release tests run the deterministic logic only, so no clinical note here. */}
                {FIELDS.filter((f) => f.kind !== "note").map((f) => (
                  <Field key={f.name} label={t(`fields.${f.name}`)}>
                    {f.kind === "bool" || f.kind === "sex" ? (
                      <select className="input" value={form.values[f.name] ?? ""} onChange={(e) => setForm({ ...form, values: { ...form.values, [f.name]: e.target.value } })}>
                        <option value="">{t("runs.notGiven")}</option>
                        {(f.kind === "bool" ? ["true", "false"] : ["female", "male", "unknown"]).map((v) => (
                          <option key={v} value={v}>
                            {t(`values.${v}`)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input className="input" type={f.kind === "number" ? "number" : "text"} value={form.values[f.name] ?? ""} onChange={(e) => setForm({ ...form, values: { ...form.values, [f.name]: e.target.value } })} />
                    )}
                  </Field>
                ))}
              </div>
            </section>
            <section className="space-y-3 border-t border-line pt-5">
              <h3 className="text-sm font-semibold text-ink">{t("release.expected")}</h3>
              <div className="field-grid sm:grid-cols-2 lg:grid-cols-4">
                <Field label={t("release.expectedOutcome")}>
                  <select className="input" value={form.outcome} onChange={(e) => setForm({ ...form, outcome: e.target.value })}>
                    {OUTCOMES.map((o) => (
                      <option key={o} value={o}>
                        {t(`runs.outcome.${o}`)}
                      </option>
                    ))}
                  </select>
                </Field>
                {decisions.map((d) => (
                  <Field key={d.id} label={d.label}>
                    <select className="input" value={form.branches[d.id] ?? ""} onChange={(e) => setForm({ ...form, branches: { ...form.branches, [d.id]: e.target.value } })}>
                      <option value="">{t("release.anyBranch")}</option>
                      <option value="yes">{t("values.yes")}</option>
                      <option value="no">{t("values.no")}</option>
                      <option value="awaiting_input">{t("runs.step.awaiting_input")}</option>
                    </select>
                  </Field>
                ))}
              </div>
              <fieldset>
                <legend className="label">{t("release.expectedFindings")}</legend>
                <div className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
                  {FINDING_CODES.map((c) => (
                    <label key={c} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={form.codes.includes(c)}
                        onChange={(e) => setForm({ ...form, codes: e.target.checked ? [...form.codes, c] : form.codes.filter((x) => x !== c) })}
                      />
                      {t(`release.codes.${c}`)}
                    </label>
                  ))}
                </div>
                <span className="hint">{t("release.findingsHint")}</span>
              </fieldset>
            </section>
            <div className="flex justify-end gap-2 border-t border-line pt-5">
              <button type="button" className="btn" onClick={() => setForm(null)}>
                {t("agents.cancel")}
              </button>
              <button type="submit" className="btn btn-primary" disabled={!form.name.trim() || busy === "case"}>
                {busy === "case" ? t("editor.saving") : t("editor.save")}
              </button>
            </div>
          </form>
        )}

        {casesQ.isLoading ? null : cases.length === 0 ? (
          !form && <p className="card text-sm text-ink-subtle">{t("release.noCases")}</p>
        ) : (
          <div className="card p-0">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t("release.caseName")}</th>
                    <th>{t("release.expectedOutcome")}</th>
                    <th className="hidden md:table-cell">{t("release.checks")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {cases.map((c) => (
                    <tr key={c.id}>
                      <td className="font-medium text-ink">{c.name}</td>
                      <td>
                        <StatusPill tone={OUTCOME_TONE[c.expected.outcome] ?? "neutral"}>{t(`runs.outcome.${c.expected.outcome}`)}</StatusPill>
                      </td>
                      <td className="hidden text-ink-muted md:table-cell">
                        {[
                          ...(c.expected.findingCodes ?? []).map((x) => t(`release.codes.${x}`, { defaultValue: x })),
                          ...(c.expected.path ?? []).map((p) => { const l = nodeLabel(p.nodeId); return `${l}${/[?:؟]$/.test(l) ? "" : ":"} ${p.port ? t(`values.${p.port}`) : t(`runs.step.${p.state}`)}`; }),
                        ].join("; ") || t("release.outcomeOnly")}
                      </td>
                      <td>
                        {canAuthor && (
                          <div className="flex justify-end gap-1">
                            <button className="icon-btn h-8 w-8" aria-label={t("release.edit")} title={t("release.edit")} onClick={() => editCase(c)}>
                              <Pencil size={15} />
                            </button>
                            <button
                              className="icon-btn h-8 w-8 hover:text-danger"
                              aria-label={t("release.delete")}
                              title={t("release.delete")}
                              onClick={() => void act(`del-${c.id}`, async () => {
                                await api(`/agents/${agentId}/test-cases/${c.id}`, { method: "DELETE" });
                                await casesQ.refetch();
                              })}
                            >
                              <Trash2 size={15} />
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function TestResults({ run, nodeLabel }: { run: TestRun | undefined; nodeLabel: (id: string) => string }) {
  const { t } = useTranslation();
  if (!run) return <p className="text-sm text-ink-subtle">{t("release.noResults")}</p>;
  const v = (x: unknown) => (Array.isArray(x) ? x.map((c) => t(`release.codes.${c}`, { defaultValue: String(c) })).join(", ") || "—" : t(`runs.outcome.${x}`, { defaultValue: t(`runs.step.${x}`, { defaultValue: t(`values.${x}`, { defaultValue: String(x ?? "") }) }) }));
  return (
    <ul className="divide-y divide-line rounded-panel border border-line">
      {run.results.map((r) => (
        <li key={r.testCaseId} className="flex gap-3 p-3">
          <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${r.passed ? "bg-success-soft text-success" : "bg-danger-soft text-danger"}`}>
            {r.passed ? <Check size={13} /> : <X size={13} />}
          </span>
          <div className="min-w-0 flex-1 text-sm">
            <div className="font-medium text-ink">{r.name}</div>
            {r.problems.map((p, i) => (
              <div key={i} className="text-ink-muted">
                {t(`release.problems.${p.kind}`, { step: p.nodeId ? nodeLabel(p.nodeId) : "", expected: v(p.expected), actual: v(p.actual) })}
              </div>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}

function DiffView({ diff }: { diff: VersionDiff | undefined }) {
  const { t } = useTranslation();
  if (!diff) return null;
  const empty = !diff.added.length && !diff.removed.length && !diff.changed.length;
  const label = (x: string) => x.replace(/^block /, `${t("release.block")} `).replace(/^connection /, `${t("release.connection")} `).replace(/^(agentPrompt|effectivePolicy|sourceBindings|clinicProfiles|scope|budget|aiModel)$/, (m) => t(`release.parts.${m}`));
  return (
    <div className="space-y-3 text-sm">
      <p className="text-ink-muted">{diff.against ? t("release.comparedWith", { no: diff.against.candidateNo }) : t("release.firstVersion")}</p>
      {empty ? (
        <p className="text-ink-subtle">{t("release.noChanges")}</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {(["added", "changed", "removed"] as const).map((k) => (
            <div key={k}>
              <h4 className="label">{t(`release.${k}`)}</h4>
              {diff[k].length ? (
                <ul className="space-y-1">
                  {diff[k].map((x) => (
                    <li key={x} className="text-ink">
                      {label(x)}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-ink-subtle">—</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
