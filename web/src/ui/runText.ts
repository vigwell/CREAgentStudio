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
    case "PROTOCOL_SELECTED": {
      const code = /protocol\s+(\S+)$/i.exec(f.title)?.[1] ?? "";
      const name = f.details?.find((d) => /protocol_?name|שם/i.test(d.label))?.value ?? "";
      return t("findings.PROTOCOL_SELECTED", { code: code ? `\u2068${code}\u2069` : "", name: name ? `\u2068${name}\u2069` : "" })
        .replace(/[:：]\s*$/, "")
        .trim();
    }
    case "ACR_RULE_PRIMARY": {
      const m = /^Review ACR rule (\S+?)(?::\s*(.*))?$/.exec(f.title);
      return t("findings.ACR_RULE_PRIMARY", { id: `\u2068${m?.[1] ?? ""}\u2069`, exam: m?.[2] ? `\u2068${m[2]}\u2069` : "" })
        .replace(/[:：]\s*$/, "")
        .trim();
    }
    case "ACR_RULE_RELATED": {
      const m = /^Related ACR rule (\S+) \(rank (\d+)\)$/.exec(f.title);
      return t("findings.ACR_RULE_RELATED", { id: `\u2068${m?.[1] ?? ""}\u2069`, rank: m?.[2] ?? "" });
    }
    case "ACR_TOPIC_UNRESOLVED":
    case "ACR_MODALITY_UNSUPPORTED":
    case "ACR_RULE_UNRESOLVED":
    case "ANATOMY_UNRESOLVED":
    case "PROTOCOL_UNRESOLVED":
      return t(`findings.${f.code}`);
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
    const kind =
      n.type === "final_synthesis"
        ? "synthesis"
        : n.type === "anatomy_detection"
          ? "anatomy"
          : n.type === "protocol_selection"
            ? "selection"
            : n.type === "acr_topic_detection"
              ? "acrTopic"
              : n.type === "acr_rule_selection"
                ? "acrRules"
                : "extraction";
    const scope = {
      count: n.ai.count ?? 0,
      topic: n.ai.topic ? `\u2068${n.ai.topic}\u2069` : "",
      modality: n.ai.modality ? n.ai.modality.toUpperCase() : "",
    };
    return t(`notes.ai.${kind}.${n.ai.status}`, { fields, ...scope, defaultValue: t(`notes.ai.${n.ai.status}`, { defaultValue: n.ai.status }) });
  }
  if (!n.note) return null;
  if (/^AI synthesis/i.test(n.note)) return t("notes.aiSynthesis");
  if (/^AI extraction/i.test(n.note)) return t("notes.aiExtraction");
  if (/^No anatomy was determined/i.test(n.note)) return t("notes.noAnatomy");
  if (/^No ACR topic was determined/i.test(n.note)) return t("notes.noAcrTopic");
  const m = /^Knowledge revision is (\w+)/i.exec(n.note);
  if (m) return m[1] === "not" ? t("notes.knowledgeMissing") : t("notes.knowledge", { status: t(`status.${m[1]}`, { defaultValue: m[1] }) });
  return n.note;
}
