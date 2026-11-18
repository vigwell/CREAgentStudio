import { useState } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api, type Revision, type StudioUser } from "../api/client";
import { StatusBadge } from "../components/StatusBadge";
import { ErrorNote } from "../components/ErrorNote";
import { invalidate, useQuery } from "../api/query";
import { DetailSkeleton } from "../ui/Skeleton";
import { Field } from "../ui/Field";

export function RevisionPage({ user }: { user: StudioUser }) {
  const { t } = useTranslation();
  const { revisionId } = useParams();
  const key = `/knowledge/revisions/${revisionId}?pageSize=200`;
  const q = useQuery<Revision>(key);
  const rev = q.data ?? null;
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");

  const load = async () => {
    invalidate("/knowledge/sources");
    await q.refetch();
  };

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

  if (!rev) return error || q.error ? <ErrorNote error={error ?? q.error} /> : <DetailSkeleton />;

  const isAuthor = rev.createdBy === user.id;
  const canAuthor = user.role !== "viewer";
  const canApprove = user.role === "approver" || user.role === "admin";
  const mappedFields = Object.values(rev.mapping);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="page-title">{t("revision.title", { name: rev.sourceName, no: rev.revisionNo })}</h1>
        <StatusBadge status={rev.status} />
      </div>
      <ErrorNote error={error} />

      <div className="card field-grid text-sm sm:grid-cols-2 lg:grid-cols-4">
        <Info label={t("knowledge.kind")} value={t(`kinds.${rev.kind}`)} />
        <Info label={t("revision.owner")} value={rev.clinicalOwner} />
        <Info label={t("revision.effectiveFrom")} value={rev.effectiveFrom ?? "—"} />
        <Info label={t("revision.reviewDue")} value={rev.reviewDue} />
        <Info label={t("wizard.sheet")} value={`${rev.sheet ?? "CSV"}, ${t("wizard.headerRow").toLowerCase()} ${rev.headerRow}`} />
        <Info label={t("knowledge.rows")} value={String(rev.rowCount)} />
        <Info label={t("revision.checksum")} value={rev.rowsSha256.slice(0, 16) + "…"} />
        <Info label={t("wizard.scope")} value={rev.scope ? Object.entries(rev.scope).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`).join("; ") : "—"} />
      </div>

      <div className={`rounded-control px-4 py-3 text-sm ${rev.errorCount ? "bg-danger-soft text-danger" : "bg-accent-soft text-accent"}`}>
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
            <Field className="min-w-64 flex-1" label={t("revision.reason")}>
              <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <button className="btn" disabled={busy || !reason.trim()} onClick={() => void act("return")}>
              {t("revision.return")}
            </button>
          </>
        )}
        {(rev.status === "approved" || rev.status === "expired") && canApprove && (
          <>
            <Field className="min-w-64 flex-1" label={t("revision.reason")}>
              <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <button className="btn btn-danger" disabled={busy || !reason.trim()} onClick={() => void act("withdraw")}>
              {t("revision.withdraw")}
            </button>
          </>
        )}
        {rev.status === "in_review" && isAuthor && <p className="text-xs text-ink-subtle">{t("revision.independentNote")}</p>}
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
              <tr key={r.rowId + r.originalRow} className={r.errors.length ? "bg-danger-soft/60" : ""}>
                <td className="text-ink-subtle">{r.originalRow}</td>
                <td className="text-ink-muted">{r.rowId}</td>
                {mappedFields.map((f) => (
                  <td key={f}>{r.mapped[f] == null ? "" : String(r.mapped[f])}</td>
                ))}
                <td className="text-danger">
                  {r.errors.map((e, i) => (
                    <div key={i}>
                      {e.ref && <span className="font-medium">{e.ref}: </span>}
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
