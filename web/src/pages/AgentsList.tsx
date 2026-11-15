import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api, type AgentKind, type AgentSummary, type StudioUser } from "../api/client";
import { ErrorNote } from "../components/ErrorNote";

export function AgentsList({ user }: { user: StudioUser }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ kind: "cds" as AgentKind, name: "", intendedUse: "", department: "", devices: "" });
  const canAuthor = user.role === "admin" || user.role === "author";

  useEffect(() => {
    api<{ agents: AgentSummary[] }>("/agents")
      .then((r) => setAgents(r.agents))
      .catch(setError);
  }, []);

  const create = async () => {
    setError(null);
    const scope: Record<string, unknown> = {};
    if (form.department.trim()) scope.department = form.department.trim();
    const devices = form.devices.split(",").map((s) => s.trim()).filter(Boolean);
    if (devices.length) scope.devices = devices;
    try {
      const a = await api<{ id: string }>("/agents", { body: { kind: form.kind, name: form.name, intendedUse: form.intendedUse, scope } });
      navigate(`/agents/${a.id}`);
    } catch (err) {
      setError(err);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-4">
        <div>
          <h1 className="text-2xl font-bold">{t("agents.title")}</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-600">{t("agents.intro")}</p>
        </div>
        {canAuthor && !creating && (
          <button className="btn btn-primary ms-auto shrink-0" onClick={() => setCreating(true)}>
            {t("agents.new")}
          </button>
        )}
      </div>
      <ErrorNote error={error} />

      {creating && (
        <div className="card grid gap-4 md:grid-cols-2">
          <label>
            <span className="label">{t("agents.kind")}</span>
            <select className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as AgentKind })}>
              <option value="cds">{t("agents.cds")}</option>
              <option value="voice">{t("agents.voice")}</option>
            </select>
          </label>
          <label>
            <span className="label">{t("agents.name")}</span>
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label className="md:col-span-2">
            <span className="label">{t("agents.intendedUse")}</span>
            <textarea className="input" rows={2} value={form.intendedUse} onChange={(e) => setForm({ ...form, intendedUse: e.target.value })} />
          </label>
          <label>
            <span className="label">{t("agents.department")}</span>
            <input className="input" value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} />
          </label>
          <label>
            <span className="label">{t("agents.devices")}</span>
            <input className="input" value={form.devices} onChange={(e) => setForm({ ...form, devices: e.target.value })} />
          </label>
          <div className="flex gap-2 md:col-span-2">
            <button className="btn btn-primary" disabled={!form.name.trim() || !form.intendedUse.trim()} onClick={() => void create()}>
              {t("agents.create")}
            </button>
            <button className="btn" onClick={() => setCreating(false)}>
              {t("agents.cancel")}
            </button>
          </div>
        </div>
      )}

      {agents && agents.length === 0 && <p className="text-slate-500">{t("agents.empty")}</p>}
      {agents && agents.length > 0 && (
        <div className="card overflow-x-auto p-0">
          <table className="table">
            <thead>
              <tr>
                <th>{t("agents.name")}</th>
                <th>{t("agents.kind")}</th>
                <th>{t("agents.intendedUse")}</th>
                <th>{t("agents.candidates")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.id}>
                  <td className="font-medium">
                    {a.name}
                    <div className="text-xs text-slate-500">{t("agents.version", { v: a.draftVersion })}</div>
                  </td>
                  <td>{t(`agents.${a.kind}`)}</td>
                  <td className="max-w-md text-slate-600">{a.intendedUse}</td>
                  <td>{a.candidates}</td>
                  <td className="text-end">
                    <Link className="btn" to={`/agents/${a.id}`}>
                      {t("agents.open")}
                    </Link>
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
