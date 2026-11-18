import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api, type FieldDef, type Preview, type SourceKind, type SourceSummary, type UploadResult } from "../api/client";
import { ErrorNote } from "../components/ErrorNote";
import { suggestMapping } from "../mapping";

interface FieldsResponse {
  fields: FieldDef[];
  requiredByKind: Record<SourceKind, (string | string[])[]>;
}

function cellText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return v.slice(0, 10);
  return String(v);
}

export function ImportWizard() {
  const { t } = useTranslation();
  const { sourceId } = useParams();
  const navigate = useNavigate();
  const [source, setSource] = useState<SourceSummary | null>(null);
  const [catalog, setCatalog] = useState<FieldsResponse | null>(null);
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [file, setFile] = useState<File | null>(null);
  const [upload, setUpload] = useState<UploadResult | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  const [headerRow, setHeaderRow] = useState(1);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [meta, setMeta] = useState({ clinicalOwner: "", effectiveFrom: "", reviewDue: "", site: "", department: "", modality: "", devices: "" });

  useEffect(() => {
    api<{ sources: SourceSummary[] }>("/knowledge/sources")
      .then((r) => setSource(r.sources.find((s) => s.id === sourceId) ?? null))
      .catch(setError);
    api<FieldsResponse>("/knowledge/fields").then(setCatalog).catch(setError);
  }, [sourceId]);

  // Preview whenever the sheet or header row changes.
  useEffect(() => {
    if (!upload || step < 2) return;
    const q = new URLSearchParams({ headerRow: String(headerRow) });
    if (sheet && upload.fileType === "xlsx") q.set("sheet", sheet);
    setError(null);
    api<Preview>(`/knowledge/files/${upload.fileId}/preview?${q}`)
      .then((p) => {
        setPreview(p);
        setMapping(suggestMapping(p.headers));
      })
      .catch((err) => {
        setPreview(null);
        setError(err);
      });
  }, [upload, sheet, headerRow, step]);

  const required = useMemo(() => {
    if (!catalog || !source) return [];
    return catalog.requiredByKind[source.kind].map((r) => (Array.isArray(r) ? r.join(" / ") : r));
  }, [catalog, source]);

  const doUpload = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const r = await api<UploadResult>("/knowledge/files", { form });
      setUpload(r);
      setSheet(r.fileType === "xlsx" ? r.sheets[0]?.name ?? null : null);
      setHeaderRow(1);
      setStep(2);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const createRevision = async () => {
    if (!upload) return;
    setBusy(true);
    setError(null);
    const scope: Record<string, unknown> = {};
    if (meta.site) scope.site = meta.site;
    if (meta.department) scope.department = meta.department;
    if (meta.modality) scope.modality = meta.modality;
    const devices = meta.devices.split(",").map((d) => d.trim()).filter(Boolean);
    if (devices.length) scope.devices = devices;
    try {
      const r = await api<{ id: string }>(`/knowledge/sources/${sourceId}/revisions`, {
        body: {
          fileId: upload.fileId,
          sheet: upload.fileType === "xlsx" ? sheet : null,
          headerRow,
          mapping: Object.fromEntries(Object.entries(mapping).filter(([, f]) => f)),
          scope: Object.keys(scope).length ? scope : null,
          clinicalOwner: meta.clinicalOwner,
          effectiveFrom: meta.effectiveFrom || null,
          reviewDue: meta.reviewDue,
        },
      });
      navigate(`/knowledge/revisions/${r.id}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const usedFields = new Set(Object.values(mapping).filter(Boolean));

  return (
    <div className="space-y-6">
      <h1 className="page-title">{t("wizard.title", { name: source?.name ?? "…" })}</h1>
      <ol className="flex flex-wrap gap-2 text-sm">
        {[1, 2, 3, 4].map((n) => (
          <li key={n} className={`rounded-full px-3 py-1 ${step === n ? "bg-accent text-accent-ink" : step > n ? "bg-accent-soft text-accent" : "bg-surface-sunken text-ink-subtle"}`}>
            {t(`wizard.step${n}`)}
          </li>
        ))}
      </ol>
      <ErrorNote error={error} />

      {step === 1 && (
        <div className="card space-y-4">
          <p className="text-sm text-ink-muted">{t("wizard.chooseFile")}</p>
          <input type="file" accept=".xlsx,.csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <div>
            <button className="btn btn-primary" disabled={!file || busy} onClick={() => void doUpload()}>
              {busy ? t("wizard.uploading") : t("wizard.upload")}
            </button>
          </div>
        </div>
      )}

      {step === 2 && upload && (
        <div className="card space-y-4">
          <div className="flex flex-wrap gap-4">
            {upload.fileType === "xlsx" && (
              <label className="w-64">
                <span className="label">{t("wizard.sheet")}</span>
                <select className="input" value={sheet ?? ""} onChange={(e) => setSheet(e.target.value)}>
                  {upload.sheets.map((s) => (
                    <option key={s.name} value={s.name}>
                      {s.name} ({s.rowCount})
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="w-40">
              <span className="label">{t("wizard.headerRow")}</span>
              <input className="input" type="number" min={1} value={headerRow} onChange={(e) => setHeaderRow(Math.max(1, Number(e.target.value) || 1))} />
            </label>
          </div>
          {preview && (
            <>
              <p className="text-sm text-ink-muted">{t("wizard.previewNote", { count: preview.totalRows })}</p>
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>#</th>
                      {preview.headers.map((h) => (
                        <th key={h}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((r) => (
                      <tr key={r.rowNumber}>
                        <td className="text-ink-subtle">{r.rowNumber}</td>
                        {preview.headers.map((h, i) => (
                          <td key={h} className={r.formulaColumns.includes(i) ? "bg-danger-soft text-danger" : ""}>
                            {r.formulaColumns.includes(i) ? "ƒ" : cellText(r.values[i])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <div className="flex gap-2">
            <button className="btn" onClick={() => setStep(1)}>
              {t("wizard.back")}
            </button>
            <button className="btn btn-primary" disabled={!preview} onClick={() => setStep(3)}>
              {t("wizard.next")}
            </button>
          </div>
        </div>
      )}

      {step === 3 && preview && catalog && (
        <div className="card space-y-4">
          <p className="text-sm text-ink-muted">{t("wizard.required", { fields: required.join(", ") || "—" })}</p>
          <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t("wizard.column")}</th>
                <th>{t("wizard.field")}</th>
              </tr>
            </thead>
            <tbody>
              {preview.headers.map((h) => (
                <tr key={h}>
                  <td className="font-medium">{h}</td>
                  <td>
                    <select
                      aria-label={h}
                      className="input"
                      value={mapping[h] ?? ""}
                      onChange={(e) => setMapping({ ...mapping, [h]: e.target.value })}
                    >
                      <option value="">{t("wizard.notMapped")}</option>
                      {catalog.fields.map((f) => (
                        <option key={f.name} value={f.name} disabled={usedFields.has(f.name) && mapping[h] !== f.name}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          <div className="flex gap-2">
            <button className="btn" onClick={() => setStep(2)}>
              {t("wizard.back")}
            </button>
            <button className="btn btn-primary" onClick={() => setStep(4)}>
              {t("wizard.next")}
            </button>
          </div>
        </div>
      )}

      {step === 4 && (
        <div className="card space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <label>
              <span className="label">{t("wizard.clinicalOwner")}</span>
              <input className="input" value={meta.clinicalOwner} onChange={(e) => setMeta({ ...meta, clinicalOwner: e.target.value })} />
            </label>
            <label>
              <span className="label">{t("wizard.effectiveFrom")}</span>
              <input className="input" type="date" value={meta.effectiveFrom} onChange={(e) => setMeta({ ...meta, effectiveFrom: e.target.value })} />
            </label>
            <label>
              <span className="label">{t("wizard.reviewDue")}</span>
              <input className="input" type="date" value={meta.reviewDue} onChange={(e) => setMeta({ ...meta, reviewDue: e.target.value })} />
            </label>
          </div>
          <fieldset className="grid gap-4 md:grid-cols-4">
            <legend className="label">{t("wizard.scope")}</legend>
            {(["site", "department", "modality", "devices"] as const).map((k) => (
              <label key={k}>
                <span className="text-xs text-ink-subtle">{t(`wizard.${k}`)}</span>
                <input className="input" value={meta[k]} onChange={(e) => setMeta({ ...meta, [k]: e.target.value })} />
              </label>
            ))}
          </fieldset>
          <div className="flex gap-2">
            <button className="btn" onClick={() => setStep(3)}>
              {t("wizard.back")}
            </button>
            <button className="btn btn-primary" disabled={busy || !meta.clinicalOwner.trim() || !meta.reviewDue} onClick={() => void createRevision()}>
              {busy ? t("wizard.creating") : t("wizard.createRevision")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
