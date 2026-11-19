/**
 * The run engine writes its finding titles and step notes in English. Findings
 * the engine creates itself are shown from their code in the UI language;
 * titles that come from the knowledge rows or the agent author are shown as written.
 */
import type { TFunction } from "i18next";
import type { Finding, NodeTrace } from "../api/client";

export function findingTitle(t: TFunction, f: Finding): string {
  const field = (x: string) => t(`fields.${x}`, { defaultValue: x });
  switch (f.code) {
    case "PROTOCOL_MATCH_REVIEW": {
      const code = /protocol\s+(\S+)$/i.exec(f.title)?.[1] ?? "";
      // Isolate the code so it reads correctly inside Hebrew / Arabic text.
      return t("findings.PROTOCOL_MATCH_REVIEW", { code: code ? `\u2068${code}\u2069` : "" }).trim();
    }
    case "PROTOCOL_CONFLICT":
    case "GUIDANCE_CONFLICT":
      return t(`findings.${f.code}`, { count: f.evidence.length });
    case "PROTOCOL_NO_MATCH":
    case "GUIDANCE_NO_MATCH":
      return t(`findings.${f.code}`);
    case "MISSING_INPUT": {
      const step = f.title.split(":")[0];
      return t("findings.MISSING_INPUT", { step, fields: f.missingInputs.map(field).join(", ") });
    }
    default:
      return f.title; // from the knowledge row or the agent author
  }
}

export function stepNote(t: TFunction, n: NodeTrace): string | null {
  if (n.ai) {
    const fields = (n.ai.fields ?? []).map((x) => t(`fields.${x}`, { defaultValue: x })).join(", ");
    const kind = n.type === "final_synthesis" ? "synthesis" : "extraction";
    return t(`notes.ai.${kind}.${n.ai.status}`, { fields, defaultValue: t(`notes.ai.${n.ai.status}`, { defaultValue: n.ai.status }) });
  }
  if (!n.note) return null;
  if (/^AI synthesis/i.test(n.note)) return t("notes.aiSynthesis");
  if (/^AI extraction/i.test(n.note)) return t("notes.aiExtraction");
  const m = /^Knowledge revision is (\w+)/i.exec(n.note);
  if (m) return m[1] === "not" ? t("notes.knowledgeMissing") : t("notes.knowledge", { status: t(`status.${m[1]}`, { defaultValue: m[1] }) });
  return n.note;
}
