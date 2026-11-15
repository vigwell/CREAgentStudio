import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api, type Revision, type StudioUser } from "../api/client";
import { StatusBadge } from "../components/StatusBadge";
import { ErrorNote } from "../components/ErrorNote";

export function RevisionPage({ user }: { user: StudioUser }) {
  const { t } = useTranslation();
  const { revisionId } = useParams();
  const [rev, setRev] = useState<Revision | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");

  const load = () => api<Revision>(`/knowledge/revisions/${revisionId}?pageSize=200`).then(setRev).catch(setError);
  useEffect(() => {
    void load();
  }, [revisionId]);

  const act = async (action: "submit" | "approve" | "return" | "withdraw") => {
    setBusy(true);
    setError(null);
    try {
      await api(`/knowledge/revisions/${revisionId}/${action}`, { body: action === "return" || action === "withdraw" ? { reason } : {} });
      setReason("");
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (!rev) return error ? <ErrorNote error={error} /> : <p className="text-sm text-slate-500">{t("app.loading")}</p>;

  const isAuthor = rev.createdBy === user.id;
  const canAuthor = user.role !== "viewer";
  const canApprove = user.role === "approver" || user.role === "admin";
  const mappedFields = Object.values(rev.mapping);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">{t("revision.title", { name: rev.sourceName, no: rev.revisionNo })}</h1>
        <StatusBadge status={rev.status} />
      </div>
      <ErrorNote error={error} />

      <div className="card grid gap-4 text-sm md:grid-cols-4">
        <Info label={t("knowledge.kind")} value={t(`kinds.${rev.kind}`)} />
        <Info label={t("revision.owner")} value={rev.clinicalOwner} />
        <Info label={t("revision.effectiveFrom")} value={rev.effectiveFrom ?? "—"} />
        <Info label={t("revision.reviewDue")} value={rev.reviewDue} />
        <Info label={t("wizard.sheet")} value={`${rev.sheet ?? "CSV"} · ${t("wizard.headerRow")} ${rev.headerRow}`} />
        <Info label={t("knowledge.rows")} value={String(rev.rowCount)} />
        <Info label={t("revision.checksum")} value={rev.rowsSha256.slice(0, 16) + "…"} />
        <Info label={t("wizard.scope")} value={rev.scope ? Object.entries(rev.scope).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`).join(" · ") : "—"} />
      </div>

      <div className={`rounded-lg px-4 py-3 text-sm ${rev.errorCount ? "bg-red-50 text-red-700" : "bg-brand-soft text-brand-strong"}`}>
        {rev.errorCount ? t("revision.rowsWithErrors", { count: rev.errorCount }) : t("revision.noErrors")}
      </div>

      <div className="card flex flex-wrap items-end gap-3">
        {rev.status === "draft" && canAuthor && (
          <button className="btn btn-primary" disabled={busy || rev.errorCount > 0} onClick={() => void act("submit")}>
            {t("revision.submit")}
          </button>
        )}
        {rev.status === "in_review" && canApprove && (
          <>
            <button className="btn btn-primary" disabled={busy || isAuthor} title={isAuthor ? t("revision.independentNote") : ""} onClick={() => void act("approve")}>
              {t("revision.approve")}
            </button>
            <label className="min-w-64 flex-1">
              <span className="label">{t("revision.reason")}</span>
              <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            <button className="btn" disabled={busy || !reason.trim()} onClick={() => void act("return")}>
              {t("revision.return")}
            </button>
          </>
        )}
        {(rev.status === "approved" || rev.status === "expired") && canApprove && (
          <>
            <label className="min-w-64 flex-1">
              <span className="label">{t("revision.reason")}</span>
              <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            <button className="btn btn-danger" disabled={busy || !reason.trim()} onClick={() => void act("withdraw")}>
              {t("revision.withdraw")}
            </button>
          </>
        )}
        {rev.status === "in_review" && isAuthor && <p className="text-xs text-slate-500">{t("revision.independentNote")}</p>}
      </div>

      <div className="card overflow-x-auto p-0">
        <table className="table">
          <thead>
            <tr>
              <th>{t("revision.row")}</th>
              <th>{t("revision.rowId")}</th>
              {mappedFields.map((f) => (
                <th key={f}>{f}</th>
              ))}
              <th>{t("revision.problems")}</th>
            </tr>
          </thead>
          <tbody>
            {rev.rows.map((r) => (
              <tr key={r.rowId + r.originalRow} className={r.errors.length ? "bg-red-50/60" : ""}>
                <td className="text-slate-400">{r.originalRow}</td>
                <td className="font-mono text-xs">{r.rowId}</td>
                {mappedFields.map((f) => (
                  <td key={f}>{r.mapped[f] == null ? "" : String(r.mapped[f])}</td>
                ))}
                <td className="text-red-700">
                  {r.errors.map((e, i) => (
                    <div key={i}>
                      {e.ref && <span className="font-mono text-xs">{e.ref}: </span>}
                      {e.message}
                    </div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div>{value}</div>
    </div>
  );
}
