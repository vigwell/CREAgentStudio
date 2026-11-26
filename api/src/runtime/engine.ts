/**
 * CDS run engine (spec rev 7 §07, §10, §17): executes a frozen candidate
 * manifest over an immutable input snapshot and approved knowledge rows.
 *
 * - Ordinary blocks activate every successor; a decision activates only the
 *   selected port. A join runs once if any activated predecessor reached it;
 *   skipped branches never supply data.
 * - Missing, denied, stale or invalid data is "unknown", never false. A
 *   decision or lookup that needs an unknown value pauses the run
 *   (awaiting_input) and lists the missing fields.
 * - Several matching rows or no match produce needs_review; the engine never
 *   picks a default protocol.
 * - Findings carry the exact rows used as evidence; output categories denied by
 *   the effective policy are dropped and recorded as blocked.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "../agents/compiler.js";
import type { AnatomyOutcome, SelectionOutcome } from "./protocolAi.js";
import type { RulesOutcome, TopicOutcome } from "./acrAi.js";

// ------------------------------------------------------------ inputs

export type FactStatus = "present" | "missing" | "denied" | "unavailable" | "stale";

export interface Fact {
  value?: unknown;
  status: FactStatus;
  sourceRef?: string | null;
  observedAt?: string | null;
  /** "manual" values carry the user who entered them; "ai" values the verbatim quote they came from. */
  attribution?: { kind: "source" | "manual" | "ai"; userId?: string | null; quote?: string };
}

export interface InputSnapshot {
  caseRef: string;
  requestedAt: string;
  facts: Record<string, Fact>;
  deviceId?: string | null;
}

export interface KnowledgeRow {
  rowId: string;
  sheet: string | null;
  originalRow: number;
  mapped: Record<string, unknown>;
  hasErrors: boolean;
  /** Every column of the row as written in the sheet (display only, never evaluated). */
  cells?: Record<string, string>;
}

export interface KnowledgeBinding {
  revisionId: string;
  sourceName: string;
  kind: string;
  /** Effective status at run time (approved | expired | withdrawn | ...). */
  status: string;
  rows: KnowledgeRow[];
}

export interface ManifestNode {
  id: string;
  type: string;
  label: string;
  executionKind: "deterministic" | "ai";
  condition: { nodeId: string; field: string; operator: string; value?: unknown } | null;
  knowledgeRevisionId: string | null;
  outputCategories: string[];
}

export interface Manifest {
  agentId: string;
  executionMode: string;
  scope: Record<string, unknown>;
  nodes: ManifestNode[];
  edges: { id: string; from: string; port: string; to: string }[];
  effectivePolicy: { rules: { id: string; binding: { type: string; category?: string } | null }[] };
}

// ------------------------------------------------------------ outputs

export type NodeState = "completed" | "skipped" | "awaiting_input" | "blocked" | "failed" | "not_reached";
export type Outcome = "findings" | "needs_input" | "needs_review" | "not_applicable" | "blocked" | "unavailable";
export type RunState = "completed" | "awaiting_input" | "failed";

export interface Evidence {
  knowledgeRevisionId: string;
  sourceName: string;
  rowId: string;
  sheet: string | null;
  sourceRow: number;
}

export interface ObservedInput {
  field: string;
  value: unknown;
  sourceRef: string | null;
  observedAt: string | null;
  attribution: string;
  /** AI-extracted values: the words in the clinical note that state them. */
  quote?: string;
}

export interface Finding {
  code: string;
  category: string;
  severity: "info" | "review" | "warning" | "critical";
  title: string;
  detail: string | null;
  nodeId: string;
  observedInputs: ObservedInput[];
  evidence: Evidence[];
  missingInputs: string[];
  allowedActions: string[];
  /** Values of the evidence row to show with the finding (e.g. protocol number, contrast, Tesla). */
  details?: { label: string; value: string }[];
}

export interface NodeTrace {
  nodeId: string;
  type: string;
  label: string;
  state: NodeState;
  /** Port taken by a decision (yes / no) or "unknown". */
  port?: string;
  outputs: Record<string, unknown>;
  unknown: string[];
  note?: string;
  /** Decisions: the rule that was evaluated and the value it saw (null = unknown). */
  evaluated?: { nodeId: string; field: string; operator: string; expected: unknown; actual: unknown };
  /** AI steps: what the AI call did (see aiSteps.ts). */
  ai?: {
    status: string;
    fields?: string[];
    reason?: string;
    answer?: string;
    /** ACR rule selection: how many rules of which topic (and catalogue) were evaluated. */
    count?: number;
    topic?: string;
    modality?: string;
  };
}

export interface RunResult {
  state: RunState;
  outcome: Outcome;
  findings: Finding[];
  blockedFindings: { code: string; category: string; ruleIds: string[] }[];
  missingInputs: string[];
  trace: NodeTrace[];
  summary: { text: string; ai: "not_configured" | "not_used" | "used" | "unavailable" | "rejected" | "model_changed"; model?: string | null } | null;
  /** Active execution time of the run, AI calls included (set by the run service). */
  durationMs?: number;
  /** One record per AI step (status, model, timing, tokens); no clinical text. */
  aiCalls?: { nodeId: string; purpose: string; status: string; model: string | null; ms: number | null; inputTokens: number | null; outputTokens: number | null; reason?: string }[];
}

const UNKNOWN = Symbol("unknown");
type Value = unknown | typeof UNKNOWN;

const PATIENT_FIELDS = ["indicationCode", "hasIndication", "ageYears", "sex", "egfr", "contrastAllergy", "pregnant", "records"];
const ACTIONS = ["acknowledge", "dismiss", "defer"];

export function snapshotHash(s: InputSnapshot): string {
  return `sha256:${createHash("sha256").update(canonicalJson(s)).digest("hex")}`;
}

function factValue(f: Fact | undefined): Value {
  if (!f || f.status !== "present" || f.value === undefined || f.value === null || f.value === "") return UNKNOWN;
  return f.value;
}

function observed(snapshot: InputSnapshot, field: string): ObservedInput {
  const f = snapshot.facts[field];
  return {
    field,
    value: f?.status === "present" ? f.value : null,
    sourceRef: f?.sourceRef ?? null,
    observedAt: f?.observedAt ?? null,
    attribution: f?.attribution?.kind === "manual" ? `manual:${f.attribution.userId ?? "unknown"}` : (f?.attribution?.kind ?? "source"),
    ...(f?.attribution?.kind === "ai" && f.attribution.quote ? { quote: f.attribution.quote } : {}),
  };
}

/** Typed comparison; any unknown side makes the result unknown. */
export function evaluate(left: Value, operator: string, right: unknown): boolean | typeof UNKNOWN {
  if (operator === "exists") return left !== UNKNOWN;
  if (left === UNKNOWN) return UNKNOWN;
  switch (operator) {
    case "eq":
      return norm(left) === norm(right);
    case "neq":
      return norm(left) !== norm(right);
    case "in":
      return Array.isArray(right) && right.map(norm).includes(norm(left));
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const a = comparable(left);
      const b = comparable(right);
      if (a === null || b === null) return UNKNOWN;
      return operator === "gt" ? a > b : operator === "gte" ? a >= b : operator === "lt" ? a < b : a <= b;
    }
    default:
      return UNKNOWN;
  }
}

function norm(v: unknown): unknown {
  return typeof v === "string" ? v.trim().toLowerCase() : v;
}

function comparable(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return Date.parse(v);
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

// ------------------------------------------------------------ row matching

interface MatchResult {
  rows: KnowledgeRow[];
  /** Inputs a row condition needed but the snapshot doesn't have. */
  missing: string[];
}

/**
 * A row applies when every mapped condition holds: condition code equals the
 * indication, age within limits, sex, and device scope. A condition on an
 * unknown input can't be decided, so the input is reported as missing.
 */
export function matchRows(binding: KnowledgeBinding, snapshot: InputSnapshot): MatchResult {
  const missing = new Set<string>();
  const rows: KnowledgeRow[] = [];
  const indication = factValue(snapshot.facts.indicationCode);
  const age = factValue(snapshot.facts.ageYears);
  const sex = factValue(snapshot.facts.sex);
  for (const row of binding.rows) {
    if (row.hasErrors) continue;
    const m = row.mapped;
    let applies: boolean | typeof UNKNOWN = true;
    const check = (r: boolean | typeof UNKNOWN, field: string) => {
      if (r === UNKNOWN) {
        missing.add(field);
        if (applies === true) applies = UNKNOWN;
      } else if (!r) applies = false;
    };
    if (m.conditionCode != null && m.conditionCode !== "") check(evaluate(indication, "eq", m.conditionCode), "indicationCode");
    if (typeof m.ageMinYears === "number") check(evaluate(age, "gte", m.ageMinYears), "ageYears");
    if (typeof m.ageMaxYears === "number") check(evaluate(age, "lte", m.ageMaxYears), "ageYears");
    if (typeof m.sex === "string" && m.sex !== "any") check(evaluate(sex, "eq", m.sex), "sex");
    if (typeof m.device === "string" && m.device.trim() && snapshot.deviceId) {
      if (norm(m.device) !== norm(snapshot.deviceId)) applies = false;
    }
    if (applies === true) rows.push(row);
  }
  // A row that may apply but can't be decided is reported only when nothing else decided it.
  return { rows, missing: rows.length ? [] : [...missing] };
}

function evidenceOf(binding: KnowledgeBinding, rows: KnowledgeRow[]): Evidence[] {
  return rows.map((r) => ({ knowledgeRevisionId: binding.revisionId, sourceName: binding.sourceName, rowId: r.rowId, sheet: r.sheet, sourceRow: r.originalRow }));
}

function severityOf(v: unknown): Finding["severity"] {
  return v === "critical" ? "critical" : v === "warning" ? "warning" : v === "info" ? "info" : "review";
}

// ------------------------------------------------------------ execution

function topoOrder(m: Manifest): string[] {
  const indeg = new Map(m.nodes.map((n) => [n.id, 0]));
  for (const e of m.edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  const queue = m.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id).sort();
  const out: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    out.push(id);
    for (const e of m.edges.filter((x) => x.from === id)) {
      indeg.set(e.to, indeg.get(e.to)! - 1);
      if (indeg.get(e.to) === 0) queue.push(e.to);
    }
  }
  return out;
}

/** Results of the AI protocol steps, computed before the engine runs (aiSteps.ts). */
export type ProtocolAiResults = Map<string, AnatomyOutcome | SelectionOutcome | TopicOutcome | RulesOutcome>;

/** ACR steps read these referral categories (any one is enough). */
const ACR_CONTEXT = ["clinicalNote", "priors", "labs", "diagnoses"];

const NOTE = "clinicalNote";

/** The row's columns to show next to a selected protocol (all columns, in sheet order). */
function rowDetails(row: KnowledgeRow): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  if (row.cells && Object.keys(row.cells).length) {
    for (const [label, value] of Object.entries(row.cells)) if (String(value).trim()) out.push({ label, value: String(value) });
    return out;
  }
  for (const f of ["anatomy", "protocolCode", "protocolName"]) if (row.mapped[f] != null) out.push({ label: f, value: String(row.mapped[f]) });
  return out;
}

export function execute(
  manifest: Manifest,
  snapshot: InputSnapshot,
  knowledge: Map<string, KnowledgeBinding>,
  protocolAi: ProtocolAiResults = new Map(),
): RunResult {
  const byId = new Map(manifest.nodes.map((n) => [n.id, n]));
  const outputs = new Map<string, Record<string, Value>>();
  const activeEdges = new Set<string>();
  const trace: NodeTrace[] = [];
  const findings: Finding[] = [];
  const missing = new Set<string>();
  let halted: { state: RunState; outcome: Outcome } | null = null;
  let needsReview = false;
  let summary: RunResult["summary"] = null;

  const denied = new Map<string, string[]>();
  for (const r of manifest.effectivePolicy.rules) {
    if (r.binding?.type === "deny_output" && r.binding.category) denied.set(r.binding.category, [...(denied.get(r.binding.category) ?? []), r.id]);
  }

  for (const id of topoOrder(manifest)) {
    const node = byId.get(id)!;
    const incoming = manifest.edges.filter((e) => e.to === id);
    const isStart = node.type === "start";
    const activated = isStart || incoming.some((e) => activeEdges.has(e.id));
    const base = { nodeId: id, type: node.type, label: node.label, outputs: {}, unknown: [] as string[] };

    if (halted) {
      trace.push({ ...base, state: "not_reached" });
      continue;
    }
    if (!activated) {
      trace.push({ ...base, state: "skipped" });
      continue;
    }

    const out: Record<string, Value> = {};
    let state: NodeState = "completed";
    let port: string | undefined;
    let note: string | undefined;
    let evaluated: NodeTrace["evaluated"];

    switch (node.type) {
      case "start":
        out.caseId = snapshot.caseRef;
        out.requestedAt = snapshot.requestedAt;
        break;

      case "patient_service":
        for (const f of PATIENT_FIELDS) out[f] = factValue(snapshot.facts[f]);
        if (out.hasIndication === UNKNOWN && out.indicationCode !== UNKNOWN) out.hasIndication = true;
        if (node.executionKind === "ai") note = "AI extraction is not configured; only structured values were used.";
        break;

      case "protocol_lookup":
      case "guidance_lookup": {
        const binding = node.knowledgeRevisionId ? knowledge.get(node.knowledgeRevisionId) : undefined;
        if (!binding || binding.status !== "approved") {
          state = "blocked";
          note = binding ? `Knowledge revision is ${binding.status}` : "Knowledge revision is not available";
          halted = { state: "completed", outcome: "blocked" };
          break;
        }
        const match = matchRows(binding, snapshot);
        if (match.missing.length) {
          state = "awaiting_input";
          match.missing.forEach((f) => missing.add(f));
          out.matched = UNKNOWN;
          halted = { state: "awaiting_input", outcome: "needs_input" };
          findings.push({
            code: "MISSING_INPUT",
            category: "missing_data_notice",
            severity: "review",
            title: `${node.label}: required inputs are missing`,
            detail: null,
            nodeId: id,
            observedInputs: match.missing.map((f) => observed(snapshot, f)),
            evidence: [],
            missingInputs: match.missing,
            allowedActions: ACTIONS,
          });
          break;
        }
        const ev = evidenceOf(binding, match.rows);
        const inputsUsed = ["indicationCode", "ageYears", "sex"].filter((f) => snapshot.facts[f]?.status === "present").map((f) => observed(snapshot, f));
        out.matched = match.rows.length > 0;
        out.matchCount = match.rows.length;
        out.rows = match.rows.map((r) => r.rowId);
        const isProtocol = node.type === "protocol_lookup";
        if (match.rows.length === 1) {
          const m = match.rows[0].mapped;
          if (isProtocol) out.protocolCode = m.protocolCode ?? UNKNOWN;
          else {
            out.rating = typeof m.rating === "number" ? m.rating : UNKNOWN;
            out.result = m.result ?? UNKNOWN;
          }
          findings.push({
            code: isProtocol ? "PROTOCOL_MATCH_REVIEW" : "GUIDANCE_MATCH_REVIEW",
            category: isProtocol ? "protocol_match" : "appropriateness_finding",
            severity: isProtocol ? "review" : severityOf(m.severity),
            title: isProtocol
              ? `Review matched local protocol ${String(m.protocolCode ?? "")}`.trim()
              : String(m.label ?? m.result ?? "Review matched guidance"),
            detail: (m.explanation as string) ?? (isProtocol ? ((m.protocolName as string) ?? null) : null),
            nodeId: id,
            observedInputs: inputsUsed,
            evidence: ev,
            missingInputs: [],
            allowedActions: ACTIONS,
          });
        } else {
          if (isProtocol) out.protocolCode = UNKNOWN;
          else {
            out.rating = UNKNOWN;
            out.result = UNKNOWN;
          }
          needsReview = true;
          findings.push({
            code: match.rows.length ? (isProtocol ? "PROTOCOL_CONFLICT" : "GUIDANCE_CONFLICT") : isProtocol ? "PROTOCOL_NO_MATCH" : "GUIDANCE_NO_MATCH",
            category: isProtocol ? "protocol_match" : "appropriateness_finding",
            severity: "review",
            title: match.rows.length ? `${match.rows.length} rows match; choose with clinical review` : "No row matches; no default is selected",
            detail: null,
            nodeId: id,
            observedInputs: inputsUsed,
            evidence: ev,
            missingInputs: [],
            allowedActions: ACTIONS,
          });
        }
        break;
      }

      case "anatomy_detection":
      case "protocol_selection": {
        const binding = node.knowledgeRevisionId ? knowledge.get(node.knowledgeRevisionId) : undefined;
        if (!binding || binding.status !== "approved") {
          state = "blocked";
          note = binding ? `Knowledge revision is ${binding.status}` : "Knowledge revision is not available";
          halted = { state: "completed", outcome: "blocked" };
          break;
        }
        if (factValue(snapshot.facts[NOTE]) === UNKNOWN) {
          state = "awaiting_input";
          missing.add(NOTE);
          halted = { state: "awaiting_input", outcome: "needs_input" };
          findings.push({
            code: "MISSING_INPUT",
            category: "missing_data_notice",
            severity: "review",
            title: `${node.label}: required inputs are missing`,
            detail: null,
            nodeId: id,
            observedInputs: [],
            evidence: [],
            missingInputs: [NOTE],
            allowedActions: ACTIONS,
          });
          break;
        }
        const pedInput: ObservedInput[] = ["pediatric", "ageYears"].filter((f) => snapshot.facts[f]?.status === "present").map((f) => observed(snapshot, f)).slice(0, 1);

        if (node.type === "anatomy_detection") {
          const r = protocolAi.get(id) as AnatomyOutcome | undefined;
          out.pediatric = r ? r.pediatric : UNKNOWN;
          if (r?.status === "used" && r.anatomy) {
            out.found = true;
            out.anatomy = r.anatomy;
          } else {
            out.found = false;
            out.anatomy = UNKNOWN;
            needsReview = true;
            findings.push({
              code: "ANATOMY_UNRESOLVED",
              category: "protocol_match",
              severity: "review",
              title: "The anatomy could not be determined from the referral; no protocol is chosen",
              detail: null,
              nodeId: id,
              observedInputs: pedInput,
              evidence: [],
              missingInputs: [],
              allowedActions: ACTIONS,
            });
          }
          break;
        }

        // protocol_selection: only within the rows of the detected anatomy.
        const detector = manifest.nodes.find((n) => n.type === "anatomy_detection");
        const a = detector ? outputs.get(detector.id) : undefined;
        if (!a || a.found !== true) {
          out.matched = false;
          out.matchCount = 0;
          out.protocolCode = UNKNOWN;
          out.protocolName = UNKNOWN;
          note = "No anatomy was determined, so no protocol is selected.";
          break;
        }
        const r = protocolAi.get(id) as SelectionOutcome | undefined;
        const rows = r?.status === "used" && r.rowIds ? binding.rows.filter((x) => r.rowIds!.includes(x.rowId)) : [];
        const anatomyInput: ObservedInput = { field: "anatomy", value: a.anatomy, sourceRef: NOTE, observedAt: null, attribution: "ai" };
        const ev = evidenceOf(binding, rows);
        out.rows = rows.map((x) => x.rowId);
        out.matchCount = rows.length;
        out.matched = rows.length === 1;
        if (rows.length === 1) {
          const m = rows[0].mapped;
          out.protocolCode = m.protocolCode ?? UNKNOWN;
          out.protocolName = m.protocolName ?? UNKNOWN;
          findings.push({
            code: "PROTOCOL_SELECTED",
            category: "protocol_match",
            severity: "review",
            title: `Review selected protocol ${String(m.protocolCode ?? "")}`.trim(),
            detail: r?.explanation || null,
            nodeId: id,
            observedInputs: [anatomyInput, ...pedInput],
            evidence: ev,
            missingInputs: [],
            allowedActions: ACTIONS,
            details: rowDetails(rows[0]),
          });
        } else {
          out.protocolCode = UNKNOWN;
          out.protocolName = UNKNOWN;
          needsReview = true;
          findings.push({
            code: rows.length ? "PROTOCOL_CONFLICT" : "PROTOCOL_UNRESOLVED",
            category: "protocol_match",
            severity: "review",
            title: rows.length ? `${rows.length} rows match; choose with clinical review` : "No protocol could be selected for this anatomy; review the referral",
            detail: rows.length ? (r?.explanation ?? null) : null,
            nodeId: id,
            observedInputs: [anatomyInput, ...pedInput],
            evidence: ev,
            missingInputs: [],
            allowedActions: ACTIONS,
          });
        }
        break;
      }

      case "acr_topic_detection":
      case "acr_rule_selection": {
        const binding = node.knowledgeRevisionId ? knowledge.get(node.knowledgeRevisionId) : undefined;
        if (!binding || binding.status !== "approved") {
          state = "blocked";
          note = binding ? `Knowledge revision is ${binding.status}` : "Knowledge revision is not available";
          halted = { state: "completed", outcome: "blocked" };
          break;
        }
        if (ACR_CONTEXT.every((f) => factValue(snapshot.facts[f]) === UNKNOWN)) {
          state = "awaiting_input";
          missing.add(NOTE);
          halted = { state: "awaiting_input", outcome: "needs_input" };
          findings.push({
            code: "MISSING_INPUT",
            category: "missing_data_notice",
            severity: "review",
            title: `${node.label}: required inputs are missing`,
            detail: null,
            nodeId: id,
            observedInputs: [],
            evidence: [],
            missingInputs: [NOTE],
            allowedActions: ACTIONS,
          });
          break;
        }

        if (node.type === "acr_topic_detection") {
          const r = protocolAi.get(id) as TopicOutcome | undefined;
          out.modality = r?.modality ?? UNKNOWN;
          if (r?.status === "used" && r.topic) {
            out.found = true;
            out.topic = r.topic;
          } else {
            out.found = false;
            out.topic = UNKNOWN;
            needsReview = true;
            const unsupported = r?.status === "unsupported";
            findings.push({
              code: unsupported ? "ACR_MODALITY_UNSUPPORTED" : "ACR_TOPIC_UNRESOLVED",
              category: "appropriateness_finding",
              severity: "review",
              title: unsupported
                ? "The requested exam is not CT or MRI; no ACR rule is selected"
                : "The ACR topic could not be determined from the referral; no rule is selected",
              detail: null,
              nodeId: id,
              observedInputs: [],
              evidence: [],
              missingInputs: [],
              allowedActions: ACTIONS,
            });
          }
          break;
        }

        // acr_rule_selection: only within the rules of the detected topic, in that modality's catalogue.
        const detector = manifest.nodes.find((n) => n.type === "acr_topic_detection");
        const a = detector ? outputs.get(detector.id) : undefined;
        out.matched = false;
        out.matchCount = 0;
        out.ruleId = UNKNOWN;
        out.recommendedExam = UNKNOWN;
        if (!a || a.found !== true) {
          note = "No ACR topic was determined, so no rule is selected.";
          break;
        }
        const r = protocolAi.get(id) as RulesOutcome | undefined;
        const byRow = new Map(binding.rows.map((x) => [x.rowId, x]));
        const picked = r?.status === "used" ? (r.selected ?? []).flatMap((s) => (byRow.has(s.rowId) ? [{ ...s, row: byRow.get(s.rowId)! }] : [])) : [];
        const topicInputs: ObservedInput[] = [
          { field: "topic", value: a.topic, sourceRef: NOTE, observedAt: null, attribution: "ai" },
          { field: "modality", value: a.modality, sourceRef: NOTE, observedAt: null, attribution: "ai" },
        ];
        out.rows = picked.map((p) => p.row.rowId);
        out.matchCount = picked.length;
        if (picked.length) {
          const primary = picked[0];
          out.matched = true;
          out.ruleId = primary.row.rowId;
          out.recommendedExam = primary.row.mapped.result ?? UNKNOWN;
          for (const p of picked) {
            const isPrimary = p === primary;
            findings.push({
              code: isPrimary ? "ACR_RULE_PRIMARY" : "ACR_RULE_RELATED",
              category: "appropriateness_finding",
              severity: isPrimary ? "review" : "info",
              title: isPrimary
                ? `Review ACR rule ${p.row.rowId}: ${String(p.row.mapped.result ?? "").trim()}`.replace(/:\s*$/, "")
                : `Related ACR rule ${p.row.rowId} (rank ${p.rank})`,
              detail: p.explanation || null,
              nodeId: id,
              observedInputs: topicInputs,
              evidence: evidenceOf(binding, [p.row]),
              missingInputs: [],
              allowedActions: ACTIONS,
              details: rowDetails(p.row),
            });
          }
        } else {
          needsReview = true;
          findings.push({
            code: "ACR_RULE_UNRESOLVED",
            category: "appropriateness_finding",
            severity: "review",
            title: "No ACR rule could be selected for this topic; review the referral",
            detail: null,
            nodeId: id,
            observedInputs: topicInputs,
            evidence: [],
            missingInputs: [],
            allowedActions: ACTIONS,
          });
        }
        break;
      }

      case "decision": {
        const c = node.condition;
        const src = c ? outputs.get(c.nodeId) : undefined;
        const left: Value = src && c ? (c.field in src ? src[c.field] : UNKNOWN) : UNKNOWN;
        const r = c ? evaluate(left, c.operator, c.value) : UNKNOWN;
        if (c) evaluated = { nodeId: c.nodeId, field: c.field, operator: c.operator, expected: c.value ?? null, actual: left === UNKNOWN ? null : left };
        if (r === UNKNOWN) {
          state = "awaiting_input";
          port = "unknown";
          const field = c ? (PATIENT_FIELDS.includes(c.field) ? c.field : `${c.nodeId}.${c.field}`) : "condition";
          missing.add(field);
          out.result = UNKNOWN;
          halted = { state: "awaiting_input", outcome: "needs_input" };
          findings.push({
            code: "MISSING_INPUT",
            category: "missing_data_notice",
            severity: "review",
            title: `${node.label}: can't decide without ${field}`,
            detail: null,
            nodeId: id,
            observedInputs: PATIENT_FIELDS.includes(field) ? [observed(snapshot, field)] : [],
            evidence: [],
            missingInputs: [field],
            allowedActions: ACTIONS,
          });
        } else {
          port = r ? "yes" : "no";
          out.result = r;
        }
        break;
      }

      case "instruction":
        findings.push({
          code: "INSTRUCTION",
          category: "safety_flag",
          severity: "info",
          title: node.label,
          detail: null,
          nodeId: id,
          observedInputs: [],
          evidence: [],
          missingInputs: [],
          allowedActions: ACTIONS,
        });
        out.finding = node.label;
        break;

      case "final_synthesis": {
        const allowed = new Set(node.outputCategories);
        const lines = findings.filter((f) => allowed.has(f.category) || f.category === "missing_data_notice").map((f) => `• ${f.title}`);
        summary = {
          text: lines.length ? lines.join("\n") : "No findings for this case.",
          // A deterministic summary is the author's choice, not a missing AI setup.
          ai: node.executionKind === "ai" ? "not_configured" : "not_used",
        };
        note = node.executionKind === "ai" ? "AI synthesis is not configured; the summary lists the deterministic findings." : undefined;
        out.summary = summary.text;
        break;
      }

      default:
        state = "failed";
        note = `Block type "${node.type}" can't run in a CDS run`;
        halted = { state: "failed", outcome: "unavailable" };
    }

    outputs.set(id, out);
    trace.push({
      ...base,
      state,
      ...(port ? { port } : {}),
      ...(note ? { note } : {}),
      ...(evaluated ? { evaluated } : {}),
      outputs: Object.fromEntries(Object.entries(out).filter(([, v]) => v !== UNKNOWN)),
      unknown: Object.entries(out)
        .filter(([, v]) => v === UNKNOWN)
        .map(([k]) => k),
    });

    if (state === "completed") {
      for (const e of manifest.edges.filter((x) => x.from === id)) {
        if (node.type === "decision" ? e.port === port : true) activeEdges.add(e.id);
      }
    }
  }

  // Policy: drop findings in denied output categories, keep a record of what was blocked.
  const blockedFindings: RunResult["blockedFindings"] = [];
  const kept = findings.filter((f) => {
    const rules = denied.get(f.category);
    if (rules) blockedFindings.push({ code: f.code, category: f.category, ruleIds: rules });
    return !rules;
  });

  if (halted) return { ...halted, findings: kept, blockedFindings, missingInputs: [...missing], trace, summary };
  const outcome: Outcome = needsReview ? "needs_review" : kept.some((f) => f.category !== "missing_data_notice") ? "findings" : "not_applicable";
  return { state: "completed", outcome, findings: kept, blockedFindings, missingInputs: [], trace, summary };
}
