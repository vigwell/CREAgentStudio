import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api, type SourceKind, type SourceSummary, type StudioUser } from "../api/client";
import { StatusBadge } from "../components/StatusBadge";
import { ErrorNote } from "../components/ErrorNote";
import { Plus } from "lucide-react";
import { invalidate, prefetch, useQuery } from "../api/query";
import { TableSkeleton } from "../ui/Skeleton";

const KINDS: SourceKind[] = ["device_protocol", "clinical_rule", "reference_document"];

export function KnowledgeList({ user }: { user: StudioUser }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const q = useQuery<{ sources: SourceSummary[] }>("/knowledge/sources");
  const sources = q.data?.sources ?? null;
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", kind: "device_protocol" as SourceKind, issuingOrg: "" });
  const canAuthor = user.role !== "viewer";

  const create = async () => {
    setError(null);
    try {
      const s = await api<{ id: string }>("/knowledge/sources", { body: { ...form, issuingOrg: form.issuingOrg || null } });
      invalidate("/knowledge/sources");
      navigate(`/knowledge/${s.id}/import`);
    } catch (err) {
      setError(err);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div>
          <h1 className="page-title">{t("knowledge.title")}</h1>
          <p className="page-intro">{t("knowledge.intro")}</p>
        </div>
        {canAuthor && !creating && (
          <button className="btn btn-primary self-start sm:ms-auto" onClick={() => setCreating(true)}>
            <Plus size={16} />
            {t("knowledge.newSource")}
          </button>
        )}
      </div>
      <ErrorNote error={error ?? q.error} />

      {creating && (
        <div className="card grid gap-4 md:grid-cols-3">
          <label>
            <span className="label">{t("knowledge.name")}</span>
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
          </label>
          <label>
            <span className="label">{t("knowledge.kind")}</span>
            <select className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as SourceKind })}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`kinds.${k}`)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="label">{t("knowledge.issuingOrg")}</span>
            <input className="input" value={form.issuingOrg} onChange={(e) => setForm({ ...form, issuingOrg: e.target.value })} />
          </label>
          <div className="flex gap-2 md:col-span-3">
            <button className="btn btn-primary" disabled={!form.name.trim()} onClick={() => void create()}>
              {t("knowledge.create")}
            </button>
            <button className="btn" onClick={() => setCreating(false)}>
              {t("knowledge.cancel")}
            </button>
          </div>
        </div>
      )}

      <div className="card overflow-x-auto p-0">
        {sources === null ? (
          <TableSkeleton bare cols={5} />
        ) : sources.length === 0 ? (
          <p className="p-5 text-sm text-ink-subtle">{t("knowledge.empty")}</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t("knowledge.name")}</th>
                <th>{t("knowledge.kind")}</th>
                <th>{t("knowledge.latest")}</th>
                <th>{t("knowledge.rows")}</th>
                <th>{t("knowledge.errors")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.id}>
                  <td className="font-medium">
                    {s.name}
                    {s.issuingOrg && <div className="text-xs text-ink-subtle">{s.issuingOrg}</div>}
                  </td>
                  <td>{t(`kinds.${s.kind}`)}</td>
                  <td>
                    {s.latestRevision ? (
                      <span className="flex items-center gap-2">
                        <span className="text-ink-subtle">#{s.latestRevision.revisionNo}</span>
                        <StatusBadge status={s.latestRevision.status} />
                      </span>
                    ) : (
                      <StatusBadge status={null} />
                    )}
                  </td>
                  <td>{s.latestRevision?.rowCount ?? "—"}</td>
                  <td className={s.latestRevision?.errorCount ? "font-semibold text-danger" : ""}>{s.latestRevision?.errorCount ?? "—"}</td>
                  <td className="whitespace-nowrap text-end">
                    {s.latestRevision && (
                      <Link className="me-3 text-sm font-medium text-accent underline" to={`/knowledge/revisions/${s.latestRevision.id}`}>
                        {t("knowledge.open")}
                      </Link>
                    )}
                    {canAuthor && (
                      <Link className="text-sm font-medium text-accent underline" to={`/knowledge/${s.id}/import`}>
                        {t("knowledge.import")}
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
