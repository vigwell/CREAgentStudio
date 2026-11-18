import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api, type AgentKind, type AgentSummary, type StudioUser } from "../api/client";
import { ErrorNote } from "../components/ErrorNote";
import { invalidate, useQuery } from "../api/query";
import { TableSkeleton } from "../ui/Skeleton";
import { warmAgent } from "./lazy";
import { Plus } from "lucide-react";
import { Field } from "../ui/Field";

export function AgentsList({ user }: { user: StudioUser }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const q = useQuery<{ agents: AgentSummary[] }>("/agents");
  const agents = q.data?.agents ?? null;
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ kind: "cds" as AgentKind, name: "", intendedUse: "", department: "", devices: "" });
  const canAuthor = user.role === "admin" || user.role === "author";


  const create = async () => {
    setError(null);
    const scope: Record<string, unknown> = {};
    if (form.department.trim()) scope.department = form.department.trim();
    const devices = form.devices.split(",").map((s) => s.trim()).filter(Boolean);
    if (devices.length) scope.devices = devices;
    try {
      const a = await api<{ id: string }>("/agents", { body: { kind: form.kind, name: form.name, intendedUse: form.intendedUse, scope } });
      invalidate("/agents");
      navigate(`/agents/${a.id}`);
    } catch (err) {
      setError(err);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div>
          <h1 className="page-title">{t("agents.title")}</h1>
          <p className="page-intro">{t("agents.intro")}</p>
        </div>
        {canAuthor && !creating && (
          <button className="btn btn-primary self-start sm:ms-auto" onClick={() => setCreating(true)}>
            <Plus size={16} />
            {t("agents.new")}
          </button>
        )}
      </div>
      <ErrorNote error={error ?? q.error} />

      {creating && (
        <div className="card field-grid md:grid-cols-2">
          <Field label={t("agents.kind")}>
            <select className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as AgentKind })}>
              <option value="cds">{t("agents.cds")}</option>
              <option value="voice">{t("agents.voice")}</option>
            </select>
          </Field>
          <Field label={t("agents.name")}>
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field className="md:col-span-2" label={t("agents.intendedUse")}>
            <textarea className="input" rows={2} value={form.intendedUse} onChange={(e) => setForm({ ...form, intendedUse: e.target.value })} />
          </Field>
          <Field label={t("agents.department")}>
            <input className="input" value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} />
          </Field>
          <Field label={t("agents.devices")}>
            <input className="input" value={form.devices} onChange={(e) => setForm({ ...form, devices: e.target.value })} />
          </Field>
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

      {agents === null && !q.error && <TableSkeleton cols={4} />}
      {agents && agents.length === 0 && <p className="text-ink-subtle">{t("agents.empty")}</p>}
      {agents && agents.length > 0 && (
        <div className="card overflow-x-auto p-0">
          <table className="table">
            <thead>
              <tr>
                <th>{t("agents.name")}</th>
                <th>{t("agents.kind")}</th>
                <th className="hidden md:table-cell">{t("agents.intendedUse")}</th>
                <th>{t("agents.candidates")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.id}>
                  <td className="font-medium">
                    {a.name}
                    <div className="text-caption text-ink-subtle">{t("agents.version", { v: a.draftVersion })}</div>
                  </td>
                  <td>{t(`agents.${a.kind}`)}</td>
                  <td className="hidden max-w-md text-ink-muted md:table-cell">{a.intendedUse}</td>
                  <td>{a.candidates}</td>
                  <td className="text-end">
                    <Link className="btn btn-sm" to={`/agents/${a.id}`} onMouseEnter={() => warmAgent(a.id)} onFocus={() => warmAgent(a.id)}>
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
