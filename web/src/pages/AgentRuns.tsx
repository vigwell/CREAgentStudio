import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api, type Agent, type Candidate, type RunDetail, type RunSummary } from "../api/client";
import { ErrorNote } from "../components/ErrorNote";

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

const OUTCOME_TONE: Record<string, string> = {
  findings: "bg-brand-soft text-brand-strong",
  needs_review: "bg-amber-100 text-amber-800",
  needs_input: "bg-sky-100 text-sky-800",
  blocked: "bg-red-100 text-red-700",
  unavailable: "bg-red-100 text-red-700",
  not_applicable: "bg-slate-100 text-slate-700",
};

export function AgentRuns() {
  const { t } = useTranslation();
  const { agentId } = useParams();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [candidateId, setCandidateId] = useState("");
  const [caseRef, setCaseRef] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [form, setForm] = useState<Record<string, string>>({});
  const [run, setRun] = useState<RunDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const loadRuns = () => api<{ runs: RunSummary[] }>(`/agents/${agentId}/runs`).then((r) => setRuns(r.runs));
  useEffect(() => {
    Promise.all([api<Agent>(`/agents/${agentId}`), api<{ candidates: Candidate[] }>(`/agents/${agentId}/candidates`), loadRuns()])
      .then(([a, c]) => {
        setAgent(a);
        setCandidates(c.candidates);
        if (c.candidates[0]) setCandidateId(c.candidates[0].id);
      })
      .catch(setError);
  }, [agentId]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const key = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now());
      const body = { agentId, candidateId, caseRef: caseRef.trim(), deviceId: deviceId.trim() || null, inputs: { manualValues: manualValues(form) } };
      const res = await api<RunDetail>("/runs", { body, headers: { "Idempotency-Key": key } });
      setRun(res);
      await loadRuns();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const review = async (index: number, action: string) => {
    if (!run) return;
    const reason = action === "acknowledge" ? null : window.prompt(t("runs.reason")) || null;
    if (action !== "acknowledge" && !reason) return;
    try {
      await api(`/runs/${run.runId}/reviews`, { body: { findingIndex: index, action, reason, snapshotHash: run.snapshotHash } });
      setRun(await api<RunDetail>(`/runs/${run.runId}`));
    } catch (err) {
      setError(err);
    }
  };

  if (!agent) return <ErrorNote error={error} />;

  return (
    <div className="space-y-6">
      <div>
        <Link to={`/agents/${agent.id}`} className="text-sm text-slate-500 hover:underline">
          {agent.name}
        </Link>
        <h1 className="text-2xl font-bold">{t("runs.title")}</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-600">{t("runs.intro")}</p>
      </div>
      <ErrorNote error={error} />

      {agent.kind !== "cds" ? (
        <p className="text-slate-500">{t("runs.voiceLater")}</p>
      ) : candidates.length === 0 ? (
        <p className="text-slate-500">{t("runs.noCandidate")}</p>
      ) : (
        <div className="card grid gap-4 md:grid-cols-3">
          <label>
            <span className="label">{t("runs.candidate")}</span>
            <select className="input" value={candidateId} onChange={(e) => setCandidateId(e.target.value)}>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.candidateNo} · {c.manifestHash.slice(7, 19)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="label">{t("runs.caseRef")}</span>
            <input className="input" value={caseRef} onChange={(e) => setCaseRef(e.target.value)} />
          </label>
          <label>
            <span className="label">{t("runs.device")}</span>
            <input className="input" value={deviceId} onChange={(e) => setDeviceId(e.target.value)} />
          </label>
          {FIELDS.map((f) => (
            <label key={f.name}>
              <span className="label">{f.name}</span>
              {f.kind === "bool" || f.kind === "sex" ? (
                <select className="input" value={form[f.name] ?? ""} onChange={(e) => setForm({ ...form, [f.name]: e.target.value })}>
                  <option value="">{t("runs.notGiven")}</option>
                  {(f.kind === "bool" ? ["true", "false"] : ["female", "male", "unknown"]).map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              ) : (
                <input className="input" type={f.kind === "number" ? "number" : "text"} value={form[f.name] ?? ""} onChange={(e) => setForm({ ...form, [f.name]: e.target.value })} />
              )}
            </label>
          ))}
          <div className="md:col-span-3">
            <button className="btn btn-primary" disabled={busy || !caseRef.trim() || !candidateId} onClick={() => void start()}>
              {t("runs.run")}
            </button>
          </div>
        </div>
      )}

      {run && (
        <div className="card space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${OUTCOME_TONE[run.outcome] ?? ""}`}>{t(`runs.outcome.${run.outcome}`)}</span>
            <span className="text-sm text-slate-600">
              {run.caseRef} · {t("runs.candidate")} #{run.candidateNo} · {run.state}
            </span>
            <code className="ms-auto text-xs text-slate-400" dir="ltr">
              {run.snapshotHash.slice(0, 19)}
            </code>
          </div>
          {run.missingInputs.length > 0 && (
            <p className="text-sm text-sky-800">
              {t("runs.missing")}: <span className="font-mono">{run.missingInputs.join(", ")}</span>
            </p>
          )}
          {run.findings.map((f, i) => {
            const reviewed = run.reviews.filter((r) => r.findingIndex === i);
            return (
              <div key={i} className="rounded-xl border border-slate-200 p-4 text-sm">
                <div className="flex items-start gap-2">
                  <div className="flex-1">
                    <div className="font-semibold">{f.title}</div>
                    {f.detail && <div className="text-slate-600">{f.detail}</div>}
                    <div className="mt-1 font-mono text-[11px] text-slate-400">
                      {f.code} · {f.category} · {f.severity}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    {f.allowedActions.map((a) => (
                      <button key={a} className="btn px-3 py-1 text-xs" onClick={() => void review(i, a)}>
                        {t(`runs.action.${a}`)}
                      </button>
                    ))}
                  </div>
                </div>
                {f.observedInputs.length > 0 && (
                  <div className="mt-2 text-xs text-slate-600">
                    <span className="label">{t("runs.observed")}</span>
                    {f.observedInputs.map((o) => (
                      <div key={o.field} dir="ltr" className="font-mono">
                        {o.field} = {JSON.stringify(o.value)} · {o.attribution}
                      </div>
                    ))}
                  </div>
                )}
                {f.evidence.length > 0 && (
                  <div className="mt-2 text-xs text-slate-600">
                    <span className="label">{t("runs.evidence")}</span>
                    {f.evidence.map((e) => (
                      <div key={e.rowId}>
                        <Link className="underline" to={`/knowledge/revisions/${e.knowledgeRevisionId}`}>
                          {e.sourceName}
                        </Link>{" "}
                        · {e.sheet ?? ""} {t("runs.row")} {e.sourceRow} · <span className="font-mono">{e.rowId}</span>
                      </div>
                    ))}
                  </div>
                )}
                {reviewed.map((r, k) => (
                  <div key={k} className="mt-2 text-xs text-brand-strong">
                    {t(`runs.action.${r.action}`)} {r.reason ? `— ${r.reason}` : ""}
                  </div>
                ))}
              </div>
            );
          })}
          {run.blockedFindings.length > 0 && (
            <p className="text-xs text-red-700">
              {t("runs.blocked")}: {run.blockedFindings.map((b) => `${b.code} (${b.ruleIds.join(", ")})`).join("; ")}
            </p>
          )}
          {run.summary && (
            <div>
              <span className="label">{t("runs.summary")}</span>
              <pre className="whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs">{run.summary.text}</pre>
            </div>
          )}
          <div>
            <span className="label">{t("runs.trace")}</span>
            <table className="table">
              <tbody>
                {run.trace.map((n) => (
                  <tr key={n.nodeId}>
                    <td className="font-medium">{n.label}</td>
                    <td className="font-mono text-xs">
                      {n.state}
                      {n.port ? ` → ${n.port}` : ""}
                    </td>
                    <td className="font-mono text-xs text-slate-500" dir="ltr">
                      {Object.keys(n.outputs).length ? JSON.stringify(n.outputs) : ""}
                      {n.unknown.length ? ` unknown: ${n.unknown.join(", ")}` : ""}
                      {n.note ? <div className="font-sans text-slate-500">{n.note}</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {runs.length > 0 && (
        <div className="card overflow-x-auto p-0">
          <table className="table">
            <thead>
              <tr>
                <th>{t("runs.caseRef")}</th>
                <th>{t("runs.candidate")}</th>
                <th>{t("runs.result")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.runId}>
                  <td>{r.caseRef}</td>
                  <td>#{r.candidateNo}</td>
                  <td>{t(`runs.outcome.${r.outcome}`)}</td>
                  <td className="text-end">
                    <button className="btn" onClick={() => void api<RunDetail>(`/runs/${r.runId}`).then(setRun).catch(setError)}>
                      {t("agents.open")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
