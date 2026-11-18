import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AgentDraft, AgentKind, Catalog } from "../api/client";
import { Field } from "../ui/Field";

type P = AgentDraft["prohibitions"];

export function Prohibitions({ kind, catalog, value, readOnly, onChange }: { kind: AgentKind; catalog: Catalog; value: P; readOnly: boolean; onChange: (p: P) => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const locked = catalog.mandatoryRules.filter((r) => r.kinds.includes(kind));
  const optional = catalog.optionalRules.filter((r) => r.kinds.includes(kind));

  const toggle = (id: string, on: boolean) =>
    onChange({ ...value, optional: on ? [...new Set([...value.optional, id])] : value.optional.filter((x) => x !== id) });

  const add = () => {
    if (!text.trim()) return;
    const id = `C${String(value.custom.length + 1).padStart(2, "0")}-${Date.now().toString(36)}`;
    onChange({ ...value, custom: [...value.custom, { id, text: text.trim(), owner: "", binding: null, reviewed: false }] });
    setText("");
  };

  return (
    <fieldset disabled={readOnly} className="grid gap-6 md:grid-cols-2">
      <div>
        <h3 className="label">{t("editor.locked")}</h3>
        <ul className="space-y-1 text-sm">
          {locked.map((r) => (
            <li key={r.id} className="flex gap-2">
              <span className="shrink-0 rounded bg-surface-sunken px-1.5 text-caption font-medium text-ink-muted">{r.id}</span>
              <span className="text-ink">{r.text}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="space-y-5">
        <div>
          <h3 className="label">{t("editor.optional")}</h3>
          {optional.map((r) => (
            <label key={r.id} className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={value.optional.includes(r.id)} onChange={(e) => toggle(r.id, e.target.checked)} />
              <span>
                <span className="me-1.5 rounded bg-surface-sunken px-1.5 text-caption font-medium text-ink-muted">{r.id}</span>
                {r.text}
              </span>
            </label>
          ))}
        </div>
        <div className="space-y-3">
          <h3 className="label">{t("editor.custom")}</h3>
          {value.custom.map((c, i) => {
            const set = (patch: Partial<typeof c>) => onChange({ ...value, custom: value.custom.map((x, k) => (k === i ? { ...x, ...patch } : x)) });
            return (
              <div key={c.id} className="space-y-2 rounded-control border border-line p-3 text-sm">
                <div className="flex gap-2">
                  <span className="flex-1">{c.text}</span>
                  <button type="button" className="text-xs text-danger underline" onClick={() => onChange({ ...value, custom: value.custom.filter((_, k) => k !== i) })}>
                    ×
                  </button>
                </div>
                <Field label={t("editor.mapTo")}>
                  <select
                    className="input"
                    value={c.binding && c.binding.type === "deny_output" ? c.binding.category : ""}
                    onChange={(e) => set({ binding: e.target.value ? { type: "deny_output", category: e.target.value } : null, reviewed: false })}
                  >
                    <option value="">{t("editor.unmapped")}</option>
                    {catalog.outputCategories.map((cat) => (
                      <option key={cat} value={cat}>
                        {t("editor.blockOutput", { category: t(`categories.${cat}`, { defaultValue: cat }) })}
                      </option>
                    ))}
                  </select>
                </Field>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={c.reviewed} disabled={!c.binding} onChange={(e) => set({ reviewed: e.target.checked })} />
                  <span>{t("editor.reviewed")}</span>
                </label>
              </div>
            );
          })}
          <div className="flex gap-2">
            <input className="input" value={text} onChange={(e) => setText(e.target.value)} />
            <button type="button" className="btn" onClick={add}>
              {t("editor.addCustom")}
            </button>
          </div>
        </div>
      </div>
    </fieldset>
  );
}
