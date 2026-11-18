import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type ClinicProfile, type StudioUser } from "../api/client";
import { StatusBadge } from "../components/StatusBadge";
import { ErrorNote } from "../components/ErrorNote";
import { useQuery } from "../api/query";
import { TableSkeleton } from "../ui/Skeleton";
import { Plus } from "lucide-react";

const EMPTY = { name: "", site: "", department: "", risProcedureCode: "", horizonDays: 30, questions: "" };

/** Questions are entered one per line and stored as yes/no screening questions. */
export function questionsFromText(text: string) {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((q, i) => ({ id: `q${i + 1}`, text: q, answerType: "yes_no" as const }));
}

export function ClinicProfiles({ user }: { user: StudioUser }) {
  const { t } = useTranslation();
  const q = useQuery<{ profiles: ClinicProfile[] }>("/clinic-profiles");
  const profiles = q.data?.profiles ?? null;
  const [error, setError] = useState<unknown>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [form, setForm] = useState<typeof EMPTY | null>(null);
  const [reviseKey, setReviseKey] = useState<string | null>(null);
  const canAuthor = user.role === "admin" || user.role === "author";
  const canApprove = user.role === "admin" || user.role === "approver";

  const load = () => q.refetch().catch(setError);

  const save = async () => {
    if (!form) return;
    setError(null);
    const body = {
      name: form.name,
      site: form.site,
      department: form.department,
      risProcedureCode: form.risProcedureCode,
      horizonDays: Number(form.horizonDays),
      questions: questionsFromText(form.questions),
    };
    try {
      await api(reviseKey ? `/clinic-profiles/${reviseKey}/revisions` : "/clinic-profiles", { body });
      setForm(null);
      setReviseKey(null);
      await load();
    } catch (err) {
      setError(err);
    }
  };

  const act = async (id: string, action: "approve" | "withdraw") => {
    setError(null);
    setBusyId(id);
    try {
      await api(`/clinic-profiles/${id}/${action}`, { method: "POST" });
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusyId(null);
    }
  };

  const revise = (p: ClinicProfile) => {
    setReviseKey(p.profileKey);
    setForm({
      name: p.name,
      site: p.site,
      department: p.department,
      risProcedureCode: p.risProcedureCode,
      horizonDays: p.horizonDays,
      questions: p.questions.map((q) => q.text).join("\n"),
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div>
          <h1 className="page-title">{t("profiles.title")}</h1>
          <p className="page-intro">{t("profiles.intro")}</p>
        </div>
        {canAuthor && !form && (
          <button className="btn btn-primary self-start sm:ms-auto" onClick={() => setForm({ ...EMPTY })}>
            <Plus size={16} />
            {t("profiles.new")}
          </button>
        )}
      </div>
      <ErrorNote error={error ?? q.error} />

      {form && (
        <div className="card grid gap-4 md:grid-cols-2">
          {(["name", "site", "department", "risProcedureCode"] as const).map((k) => (
            <label key={k}>
              <span className="label">{t(`profiles.${k === "risProcedureCode" ? "ris" : k}`)}</span>
              <input className="input" value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
            </label>
          ))}
          <label>
            <span className="label">{t("profiles.horizon")}</span>
            <input
              className="input"
              type="number"
              min={1}
              max={365}
              value={form.horizonDays}
              onChange={(e) => setForm({ ...form, horizonDays: Number(e.target.value) })}
            />
          </label>
          <label className="md:col-span-2">
            <span className="label">{t("profiles.questions")}</span>
            <textarea className="input" rows={4} value={form.questions} onChange={(e) => setForm({ ...form, questions: e.target.value })} />
          </label>
          <div className="flex gap-2 md:col-span-2">
            <button className="btn btn-primary" onClick={() => void save()}>
              {t("profiles.create")}
            </button>
            <button
              className="btn"
              onClick={() => {
                setForm(null);
                setReviseKey(null);
              }}
            >
              {t("agents.cancel")}
            </button>
          </div>
        </div>
      )}

      {profiles === null && !q.error && <TableSkeleton cols={5} />}
      {profiles && profiles.length > 0 && (
        <div className="card overflow-x-auto p-0">
          <table className="table">
            <thead>
              <tr>
                <th>{t("profiles.name")}</th>
                <th>{t("profiles.site")}</th>
                <th>{t("profiles.ris")}</th>
                <th>{t("profiles.horizon")}</th>
                <th>{t("profiles.questions")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {profiles.map((p) => (
                <tr key={p.id}>
                  <td className="font-medium">
                    {p.name} <span className="text-xs text-ink-subtle">{t("profiles.rev", { n: p.revisionNo })}</span>
                    <div className="mt-1">
                      <StatusBadge status={p.status} />
                    </div>
                  </td>
                  <td>
                    {p.site}
                    <div className="text-xs text-ink-subtle">{p.department}</div>
                  </td>
                  <td className="font-mono text-xs">{p.risProcedureCode}</td>
                  <td>{p.horizonDays}</td>
                  <td className="text-xs text-ink-muted">{p.questions.length}</td>
                  <td className="text-end">
                    <div className="flex flex-wrap justify-end gap-2">
                    {canApprove && p.status === "draft" && p.createdBy !== user.id && (
                      <button className="btn btn-primary" disabled={busyId === p.id} onClick={() => void act(p.id, "approve")}>
                        {t("profiles.approve")}
                      </button>
                    )}
                    {canAuthor && p.status !== "withdrawn" && (
                      <button className="btn" onClick={() => revise(p)}>
                        {t("profiles.newRevision")}
                      </button>
                    )}
                    {canApprove && p.status === "approved" && (
                      <button className="btn btn-danger" disabled={busyId === p.id} onClick={() => void act(p.id, "withdraw")}>
                        {t("profiles.withdraw")}
                      </button>
                    )}
                    </div>
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
