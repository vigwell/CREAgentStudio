import { useTranslation } from "react-i18next";
import type { BlockDef, Catalog, ClinicProfile, GraphNode, Issue, SourceSummary } from "../api/client";
import { blockLabel, formatConditionValue, parseConditionValue, upstreamOf, type Graph } from "./graph";
import { Field } from "../ui/Field";

type Props = {
  graph: Graph;
  node: GraphNode;
  defs: Map<string, BlockDef>;
  catalog: Catalog;
  sources: SourceSummary[];
  profiles: ClinicProfile[];
  issues: Issue[];
  readOnly: boolean;
  onChange: (patch: Partial<GraphNode>) => void;
  onDelete: () => void;
};

export function Inspector({ graph, node, defs, catalog, sources, profiles, issues, readOnly, onChange, onDelete }: Props) {
  const { t } = useTranslation();
  const def = defs.get(node.type);
  const upstream = upstreamOf(graph, node.id);
  const isAi = node.executionKind === "ai" || (def?.terminal && def.aiCapable);
  const cond = node.condition ?? null;
  const condSource = cond ? graph.nodes.find((n) => n.id === cond.nodeId) : undefined;
  const condField = condSource ? defs.get(condSource.type)?.outputs.find((o) => o.name === cond?.field) : undefined;
  const approvedKnowledge = def?.knowledgeKind
    ? sources.filter((s) => s.kind === def.knowledgeKind && s.latestRevision?.status === "approved")
    : [];
  const approvedProfiles = profiles.filter((p) => p.status === "approved");
  const showsOutputs = def?.aiCapable || def?.terminal;

  return (
    <fieldset disabled={readOnly} className="space-y-4">
      <div className="text-sm font-medium text-ink-muted">{blockLabel(t, def, node.type)}</div>
      {issues.length > 0 && (
        <ul className="space-y-1 rounded-control border border-danger/40 bg-danger-soft p-2 text-xs text-danger">
          {issues.map((i, k) => (
            <li key={k}>{i.message}</li>
          ))}
        </ul>
      )}
      <Field label={t("editor.label")}>
        <input className="input" value={node.label} onChange={(e) => onChange({ label: e.target.value })} />
      </Field>

      {def?.aiCapable && !def.terminal && !def.aiRequired && (
        <Field label={t("editor.execution")}>
          <select className="input" value={node.executionKind ?? "deterministic"} onChange={(e) => onChange({ executionKind: e.target.value as "deterministic" | "ai" })}>
            <option value="deterministic">{t("editor.deterministic")}</option>
            <option value="ai">{t("editor.ai")}</option>
          </select>
        </Field>
      )}

      {isAi && (
        <div className="space-y-2">
          <div className="field-grid sm:grid-cols-2">
            <Field label={t("editor.promptId")}>
              <input className="input" value={node.prompt?.promptId ?? ""} onChange={(e) => onChange({ prompt: { ...node.prompt, promptId: e.target.value || null } })} />
            </Field>
            <Field label={t("editor.promptRev")}>
              <input className="input" value={node.prompt?.revisionId ?? ""} onChange={(e) => onChange({ prompt: { ...node.prompt, revisionId: e.target.value || null } })} />
            </Field>
          </div>
          <Field label={t("editor.draftPrompt")}>
            <textarea
              className="input"
              rows={def?.defaultPrompt ? 10 : 4}
              dir="auto"
              value={node.prompt?.draftText ?? ""}
              onChange={(e) => onChange({ prompt: { ...node.prompt, draftText: e.target.value || null } })}
            />
            {def?.defaultPrompt && <span className="hint">{t("editor.defaultPromptHint")}</span>}
          </Field>
        </div>
      )}

      {node.type === "decision" && (
        <div className="space-y-2">
          <span className="label">{t("editor.condition")}</span>
          <select
            className="input"
            aria-label={t("editor.source")}
            value={cond?.nodeId ?? ""}
            onChange={(e) => onChange({ condition: e.target.value ? { nodeId: e.target.value, field: "", operator: "eq" } : null })}
          >
            <option value="">{t("editor.none")}</option>
            {upstream.map((n) => (
              <option key={n.id} value={n.id}>
                {n.label}
              </option>
            ))}
          </select>
          {cond && condSource && (
            <>
              <select className="input" aria-label={t("editor.field")} value={cond.field} onChange={(e) => onChange({ condition: { ...cond, field: e.target.value } })}>
                <option value="">{t("editor.none")}</option>
                {defs.get(condSource.type)?.outputs.map((o) => (
                  <option key={o.name} value={o.name}>
                    {t(`fields.${o.name}`, { defaultValue: o.name })}
                  </option>
                ))}
              </select>
              <select
                className="input"
                aria-label={t("editor.operator")}
                value={cond.operator}
                onChange={(e) => onChange({ condition: { ...cond, operator: e.target.value, value: e.target.value === "exists" ? undefined : cond.value } })}
              >
                {catalog.operators.map((o) => (
                  <option key={o} value={o}>
                    {t(`ops.${o}`, { defaultValue: o })}
                  </option>
                ))}
              </select>
              {cond.operator !== "exists" &&
                (condField?.values && cond.operator !== "in" ? (
                  <select className="input" aria-label={t("editor.value")} value={formatConditionValue(cond.value)} onChange={(e) => onChange({ condition: { ...cond, value: parseConditionValue(e.target.value, condField.type, cond.operator) } })}>
                    <option value="">{t("editor.none")}</option>
                    {condField.values.map((v) => (
                      <option key={v} value={v}>
                        {t(`values.${v}`, { defaultValue: v })}
                      </option>
                    ))}
                  </select>
                ) : condField?.type === "boolean" ? (
                  <select className="input" aria-label={t("editor.value")} value={formatConditionValue(cond.value)} onChange={(e) => onChange({ condition: { ...cond, value: parseConditionValue(e.target.value, "boolean", cond.operator) } })}>
                    <option value="">{t("editor.none")}</option>
                    <option value="true">{t("values.true")}</option>
                    <option value="false">{t("values.false")}</option>
                  </select>
                ) : (
                  <input
                    className="input"
                    aria-label={t("editor.value")}
                    value={formatConditionValue(cond.value)}
                    onChange={(e) => onChange({ condition: { ...cond, value: parseConditionValue(e.target.value, condField?.type, cond.operator) } })}
                  />
                ))}
            </>
          )}
        </div>
      )}

      {def?.knowledgeKind && (
        <Field label={t("editor.knowledge")}>
          <select className="input" value={node.knowledgeRevisionId ?? ""} onChange={(e) => onChange({ knowledgeRevisionId: e.target.value || null })}>
            <option value="">{t("editor.none")}</option>
            {approvedKnowledge.map((s) => (
              <option key={s.latestRevision!.id} value={s.latestRevision!.id}>
                {s.name}, {t("profiles.rev", { n: s.latestRevision!.revisionNo })}
              </option>
            ))}
          </select>
        </Field>
      )}

      {node.type === "clinic_profile" && (
        <Field label={t("editor.profile")}>
          <select className="input" value={node.clinicProfileId ?? ""} onChange={(e) => onChange({ clinicProfileId: e.target.value || null })}>
            <option value="">{t("editor.none")}</option>
            {approvedProfiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.risProcedureCode}), {t("profiles.rev", { n: p.revisionNo })}
              </option>
            ))}
          </select>
        </Field>
      )}

      {showsOutputs && (
        <div>
          <span className="label">{t("editor.outputs")}</span>
          <div className="grid grid-cols-1 gap-1 text-sm">
            {catalog.outputCategories.map((c) => (
              <label key={c} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={(node.outputCategories ?? []).includes(c)}
                  onChange={(e) => {
                    const cur = new Set(node.outputCategories ?? []);
                    if (e.target.checked) cur.add(c);
                    else cur.delete(c);
                    onChange({ outputCategories: [...cur] });
                  }}
                />
                <span className="text-sm">{t(`categories.${c}`, { defaultValue: c })}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {!def?.start && (
        <button type="button" className="btn btn-danger" onClick={onDelete}>
          {t("editor.delete")}
        </button>
      )}
    </fieldset>
  );
}
