/**
 * Read a scanned referral (PDF or image) into the referral text, through
 * CRE's OCR (POST /api/referrals/text). The text stays visible and editable,
 * so OCR mistakes can be seen and corrected before the run.
 */
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileScan } from "lucide-react";
import { api } from "../api/client";

/** Same limit as the run's referral text (the AI steps read up to this). */
export const NOTE_MAX = 8000;
const ACCEPT = ".pdf,.jpg,.jpeg,.png,.gif,.bmp";

export function ScanReader({ onText }: { onText: (text: string) => void }) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: "ok" | "warn" | "error"; text: string } | null>(null);

  async function read(files: FileList | null) {
    if (!files?.length) return;
    const form = new FormData();
    for (const f of Array.from(files)) form.append("files", f, f.name);
    setBusy(true);
    setStatus(null);
    try {
      const r = await api<{ text: string; files: string[] }>("/referrals/text", { method: "POST", form });
      const text = r.text ?? "";
      if (!text.trim()) {
        setStatus({ tone: "warn", text: t("runs.scan.empty") });
        return;
      }
      onText(text.slice(0, NOTE_MAX));
      const done = t("runs.scan.done", { files: r.files.join(", "), count: text.length });
      setStatus({ tone: text.length > NOTE_MAX ? "warn" : "ok", text: text.length > NOTE_MAX ? `${done} ${t("runs.scan.cut", { max: NOTE_MAX })}` : done });
    } catch (err) {
      setStatus({ tone: "error", text: t("runs.scan.failed", { message: (err as Error).message }) });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => input.current?.click()}>
          <FileScan size={16} />
          {busy ? t("runs.scan.reading") : t("runs.scan.read")}
        </button>
        <span className="hint">{t("runs.scan.hint")}</span>
      </div>
      <input ref={input} type="file" className="sr-only" accept={ACCEPT} multiple aria-label={t("runs.scan.read")} onChange={(e) => void read(e.target.files)} />
      {status && (
        <p role="status" className={`text-sm ${status.tone === "error" ? "text-danger" : status.tone === "warn" ? "text-warning" : "text-success"}`}>
          {status.text}
        </p>
      )}
    </div>
  );
}
