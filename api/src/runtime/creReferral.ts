/**
 * Scanned referrals → text, through CRE's existing protocol service (Vigen,
 * 25 Nov 2026: "reuse POST /api/Protocol/ExtractReferralText; it takes the
 * FileId returned by the referral upload step").
 *
 *   POST {CRE}/api/Protocol/UploadReferralFile   multipart "Files" → { fileId }
 *   POST {CRE}/api/Protocol/ExtractReferralText  { fileId }        → extracted text
 *
 * The same calls CRE web makes (MedilisReportingWebApp src/api/protocolApi.js),
 * with the signed-in user's CRE token: Studio users sign in with the CRE
 * account and the CRE API scope, so CRE checks the user as it does for CRE
 * web. The Studio never stores the file; the text goes back to the page,
 * where the user sees and can correct it before the run (the setup guide:
 * keep the OCR text visible so extraction errors can be told from selection
 * errors). Neither the token nor the text is logged.
 */
import { AppError } from "../errors.js";

export const REFERRAL_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  bmp: "image/bmp",
};
/** The CRE service's limit per file. */
export const REFERRAL_MAX_BYTES = 30 * 1024 * 1024;
export const REFERRAL_MAX_FILES = 5;

export interface ReferralFile {
  name: string;
  data: Buffer;
}

export interface ReferralText {
  fileId: string;
  text: string;
}

export interface CreReferralClient {
  readonly baseUrl: string;
  extractText(token: string, files: ReferralFile[]): Promise<ReferralText>;
}

export function referralType(name: string): string | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return REFERRAL_TYPES[ext] ?? null;
}

/** CRE replies { success, payload, errorInfo } (camel or Pascal case). */
function envelope(body: unknown): unknown {
  const b = (body ?? {}) as Record<string, unknown>;
  const ok = b.success ?? b.Success;
  if (ok === false) {
    const info = (b.errorInfo ?? b.ErrorInfo ?? {}) as Record<string, unknown>;
    throw new AppError(502, "cre_ocr_failed", `CRE: ${String(info.message ?? info.Message ?? "the request failed")}`);
  }
  return b.payload ?? b.Payload ?? body;
}

function pick(o: unknown, ...keys: string[]): unknown {
  if (!o || typeof o !== "object") return undefined;
  for (const k of keys) if ((o as Record<string, unknown>)[k] != null) return (o as Record<string, unknown>)[k];
  return undefined;
}

/**
 * CRE's OCR text is the full text followed by every word again, joined with
 * ", " (Google Vision's full annotation, then one annotation per word): seen on
 * the live service, 26 Nov 2026. Keep only the full text when the tail is
 * exactly its words; otherwise return the text as it came.
 */
export function withoutWordList(text: string): string {
  const squash = (s: string) => s.replace(/\s+/g, "");
  for (let i = text.indexOf(", "); i > 0; i = text.indexOf(", ", i + 1)) {
    const head = text.slice(0, i);
    const tail = text.slice(i + 2);
    if (tail && squash(head) === squash(tail.split(", ").join(""))) return head.trim();
  }
  return text;
}

/** The extracted text from ExtractReferralText's payload (a string, or an object with the text). */
export function textOf(payload: unknown): string | null {
  if (typeof payload === "string") return payload;
  const v = pick(payload, "extractedText", "ExtractedText", "text", "Text", "referralText", "ReferralText");
  return typeof v === "string" ? v : null;
}

export function createCreReferralClient(opts: { baseUrl: string; fetchImpl?: typeof fetch; timeoutMs?: number }): CreReferralClient {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 90_000;

  async function call(path: string, token: string, body: FormData | string): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, ...(typeof body === "string" ? { "content-type": "application/json" } : {}) },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = (err as Error).name;
      if (name === "TimeoutError" || name === "AbortError") throw new AppError(504, "cre_timeout", "CRE didn't answer in time");
      throw new AppError(502, "cre_unreachable", "CRE can't be reached");
    }
    if (res.status === 401 || res.status === 403) throw new AppError(502, "cre_auth", `CRE refused the request (HTTP ${res.status})`);
    if (!res.ok) throw new AppError(502, "cre_ocr_failed", `CRE answered HTTP ${res.status}`);
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new AppError(502, "cre_ocr_failed", "CRE's reply was not JSON");
    }
    return envelope(json);
  }

  return {
    baseUrl: base,
    async extractText(token, files) {
      const form = new FormData();
      for (const f of files) form.append("Files", new Blob([new Uint8Array(f.data)], { type: referralType(f.name) ?? "application/octet-stream" }), f.name);
      const uploaded = await call("/api/Protocol/UploadReferralFile", token, form);
      const fileId = pick(uploaded, "fileId", "FileId");
      if (typeof fileId !== "string" || !fileId) throw new AppError(502, "cre_ocr_failed", "CRE returned no file id");
      const extracted = await call("/api/Protocol/ExtractReferralText", token, JSON.stringify({ fileId }));
      const text = textOf(extracted);
      if (text === null) throw new AppError(502, "cre_ocr_failed", "CRE returned no text");
      return { fileId, text: withoutWordList(text.trim()) };
    },
  };
}
