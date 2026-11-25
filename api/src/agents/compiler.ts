/**
 * Agent graph compiler (spec rev 7 §16–17 and §08; rev 9 §27).
 *
 * validate(): one start, terminals, unique ids, permitted block types per kind,
 * valid ports, reachability, complete Yes/No branches, no cycles or dead ends,
 * explicit typed input bindings to upstream fields, typed decisions, approved
 * knowledge only, AI call budget, prompts for AI steps, prohibitions (unmapped
 * custom rules, denied output categories), and for voice: every path to
 * booking passes the guards and confirmation immediately precedes booking.
 *
 * compile(): a manifest of the executable semantics only (coordinates are not
 * part of it) with a SHA-256 hash of its canonical form, plus a readable
 * preview. The preview is documentation, not the runtime.
 */
import { createHash } from "node:crypto";
import { BLOCK_BY_TYPE, OPERATORS, type AgentKind, type BlockDef, type OutputField } from "./blocks.js";
import { PLATFORM_POLICY_REVISION, deniedOutputs, effectiveRules, OUTPUT_CATEGORIES, type AgentProhibitions } from "./policy.js";

export interface PromptRef {
  /** CRE Prompt Builder record and immutable revision (reused, not copied). */
  promptId?: string | null;
  revisionId?: string | null;
  /** Local draft text, saved to the Prompt Builder before a candidate is frozen. */
  draftText?: string | null;
}

export interface GraphNode {
  id: string;
  type: string;
  label: string;
  executionKind?: "deterministic" | "ai";
  prompt?: PromptRef | null;
  inputBindings?: Record<string, { nodeId: string; field: string }>;
  condition?: { nodeId: string; field: string; operator: string; value?: unknown } | null;
  knowledgeRevisionId?: string | null;
  clinicProfileId?: string | null;
  outputCategories?: string[];
  /** Presentation only: never part of the manifest or its hash. */
  position?: { x: number; y: number };
}

export interface GraphEdge {
  id: string;
  from: string;
  port: string;
  to: string;
}

export interface AgentGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface CompileContext {
  agentId: string;
  kind: AgentKind;
  scope: Record<string, unknown>;
  executionMode: string;
  agentPrompt?: PromptRef | null;
  prohibitions: AgentProhibitions;
  /** Knowledge revisions the graph may reference: id → status and source kind. */
  knowledge: Map<string, { status: string; kind: string }>;
  /** Clinic & exam profiles: id → status. */
  clinicProfiles: Map<string, { status: string }>;
  maxAiCalls?: number;
  /** The AI deployment this server uses; frozen into versions with AI steps. */
  aiModel?: { provider: string; deployment: string } | null;
}

export interface Issue {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export const DEFAULT_MAX_AI_CALLS = 2;

/** Every path to booking passes these blocks (rev 9 §27, §33). */
const VOICE_GUARDS = ["verify_authority", "resolve_order", "clinic_profile", "offer_slots", "confirmation"] as const;

function hasPrompt(p: PromptRef | null | undefined): boolean {
  return !!p && (!!(p.promptId && p.revisionId) || !!p.draftText?.trim());
}

export function validate(graph: AgentGraph, ctx: CompileContext): Issue[] {
  const issues: Issue[] = [];
  const add = (code: string, message: string, at: { nodeId?: string; edgeId?: string } = {}) => issues.push({ code, message, ...at });
  const nodes = new Map<string, GraphNode>();
  const defs = new Map<string, BlockDef>();

  for (const n of graph.nodes) {
    if (!n.id || !/^[A-Za-z0-9_-]{1,64}$/.test(n.id)) add("bad_id", `Block id "${n.id}" is invalid`, { nodeId: n.id });
    if (nodes.has(n.id)) add("duplicate_id", `Block id "${n.id}" is used twice`, { nodeId: n.id });
    nodes.set(n.id, n);
    const def = BLOCK_BY_TYPE.get(n.type);
    if (!def) {
      add("unknown_type", `Unknown block type "${n.type}"`, { nodeId: n.id });
      continue;
    }
    if (!def.kinds.includes(ctx.kind)) add("type_not_allowed", `${def.label} is not available in a ${ctx.kind} agent`, { nodeId: n.id });
    defs.set(n.id, def);
    if (!String(n.label ?? "").trim()) add("label_required", `${def.label}: a label is required`, { nodeId: n.id });
  }

  const starts = graph.nodes.filter((n) => defs.get(n.id)?.start);
  if (starts.length !== 1) add("start_count", `A graph needs exactly one Start block (found ${starts.length})`);
  const terminals = graph.nodes.filter((n) => defs.get(n.id)?.terminal);
  if (ctx.kind === "cds") {
    const finals = graph.nodes.filter((n) => n.type === "final_synthesis");
    if (finals.length !== 1) add("final_count", `A CDS agent needs exactly one Final synthesis block (found ${finals.length})`);
  } else if (!terminals.some((n) => n.type === "book")) {
    add("no_booking", "A voice scheduling agent needs a Book in RIS block");
  }

  // Edges and ports
  const outEdges = new Map<string, GraphEdge[]>();
  const inEdges = new Map<string, GraphEdge[]>();
  const edgeIds = new Set<string>();
  for (const e of graph.edges) {
    if (edgeIds.has(e.id)) add("duplicate_edge", `Connection id "${e.id}" is used twice`, { edgeId: e.id });
    edgeIds.add(e.id);
    const from = defs.get(e.from);
    if (!nodes.has(e.from) || !nodes.has(e.to)) {
      add("dangling_edge", "A connection points to a missing block", { edgeId: e.id });
      continue;
    }
    if (e.from === e.to) add("self_loop", "A block cannot connect to itself", { edgeId: e.id });
    if (from && !from.ports.includes(e.port)) add("bad_port", `${from.label} has no "${e.port}" exit`, { edgeId: e.id, nodeId: e.from });
    if (defs.get(e.to)?.start) add("into_start", "Nothing can connect into Start", { edgeId: e.id });
    (outEdges.get(e.from) ?? outEdges.set(e.from, []).get(e.from)!).push(e);
    (inEdges.get(e.to) ?? inEdges.set(e.to, []).get(e.to)!).push(e);
  }
  for (const [id, def] of defs) {
    const outs = outEdges.get(id) ?? [];
    for (const port of def.ports) {
      const count = outs.filter((e) => e.port === port).length;
      if (count === 0) {
        add(def.ports.length > 1 ? "missing_branch" : "dead_end", def.ports.length > 1 ? `${nodes.get(id)!.label}: the "${port}" exit is not connected` : `${nodes.get(id)!.label} leads nowhere`, { nodeId: id });
      }
      if (count > 1 && def.ports.length > 1) add("branch_fanout", `${nodes.get(id)!.label}: the "${port}" exit must lead to one block`, { nodeId: id });
    }
    if (def.terminal && outs.length) add("terminal_has_exit", `${nodes.get(id)!.label} is an end block and cannot continue`, { nodeId: id });
  }

  // Cycles (Kahn) and topological order
  const indeg = new Map<string, number>([...nodes.keys()].map((id) => [id, (inEdges.get(id) ?? []).length]));
  const queue = [...indeg].filter(([, d]) => d === 0).map(([id]) => id).sort();
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const e of (outEdges.get(id) ?? []).slice().sort((a, b) => a.to.localeCompare(b.to))) {
      const d = indeg.get(e.to)! - 1;
      indeg.set(e.to, d);
      if (d === 0) queue.push(e.to);
    }
  }
  const acyclic = order.length === nodes.size;
  if (!acyclic) add("cycle", "The graph has a loop; agents must be acyclic");

  // Reachability from start
  const start = starts[0];
  const reachable = new Set<string>();
  if (start) {
    const stack = [start.id];
    while (stack.length) {
      const id = stack.pop()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const e of outEdges.get(id) ?? []) stack.push(e.to);
    }
    for (const id of nodes.keys()) if (!reachable.has(id)) add("unreachable", `${nodes.get(id)!.label} cannot be reached from Start`, { nodeId: id });
  }

  // Ancestors (for bindings): all blocks with a path to the node
  const ancestors = new Map<string, Set<string>>();
  if (acyclic) {
    for (const id of order) {
      const set = new Set<string>();
      for (const e of inEdges.get(id) ?? []) {
        set.add(e.from);
        for (const a of ancestors.get(e.from) ?? []) set.add(a);
      }
      ancestors.set(id, set);
    }
  }
  const fieldOf = (nodeId: string, field: string): OutputField | undefined => defs.get(nodeId)?.outputs.find((f) => f.name === field);

  let aiCalls = 0;
  for (const n of graph.nodes) {
    const def = defs.get(n.id);
    if (!def) continue;
    const up = ancestors.get(n.id) ?? new Set<string>();

    for (const [input, b] of Object.entries(n.inputBindings ?? {})) {
      if (!nodes.has(b.nodeId)) add("binding_missing", `${n.label}: input "${input}" points to a missing block`, { nodeId: n.id });
      else if (acyclic && !up.has(b.nodeId)) add("binding_not_upstream", `${n.label}: input "${input}" must come from a block before it`, { nodeId: n.id });
      else if (!fieldOf(b.nodeId, b.field)) add("binding_field", `${n.label}: "${b.field}" is not an output of ${nodes.get(b.nodeId)!.label}`, { nodeId: n.id });
    }

    if (n.type === "decision") {
      const c = n.condition;
      if (!c) add("condition_required", `${n.label}: choose a typed condition`, { nodeId: n.id });
      else {
        const field = nodes.has(c.nodeId) ? fieldOf(c.nodeId, c.field) : undefined;
        if (!nodes.has(c.nodeId) || (acyclic && !up.has(c.nodeId))) add("condition_source", `${n.label}: the condition must read a block before it`, { nodeId: n.id });
        else if (!field) add("condition_field", `${n.label}: "${c.field}" is not an output of ${nodes.get(c.nodeId)!.label}`, { nodeId: n.id });
        else if (!OPERATORS.includes(c.operator as never)) add("condition_operator", `${n.label}: unknown operator "${c.operator}"`, { nodeId: n.id });
        else {
          const problem = conditionProblem(field, c.operator, c.value);
          if (problem) add("condition_value", `${n.label}: ${problem}`, { nodeId: n.id });
        }
      }
    }

    if (def.knowledgeKind) {
      const k = n.knowledgeRevisionId ? ctx.knowledge.get(n.knowledgeRevisionId) : undefined;
      if (!n.knowledgeRevisionId) add("knowledge_required", `${n.label}: choose an approved ${def.knowledgeKind.replace("_", " ")} revision`, { nodeId: n.id });
      else if (!k) add("knowledge_missing", `${n.label}: the knowledge revision does not exist`, { nodeId: n.id });
      else if (k.kind !== def.knowledgeKind) add("knowledge_kind", `${n.label}: needs a ${def.knowledgeKind.replace("_", " ")}, not a ${k.kind.replace("_", " ")}`, { nodeId: n.id });
      else if (k.status !== "approved") add("knowledge_not_approved", `${n.label}: the knowledge revision is ${k.status}; only approved revisions can be used`, { nodeId: n.id });
    }

    if (n.type === "clinic_profile") {
      const p = n.clinicProfileId ? ctx.clinicProfiles.get(n.clinicProfileId) : undefined;
      if (!p) add("profile_required", `${n.label}: choose a clinic & exam profile`, { nodeId: n.id });
      else if (p.status !== "approved") add("profile_not_approved", `${n.label}: the clinic & exam profile is ${p.status}`, { nodeId: n.id });
    }

    const ai = n.executionKind === "ai";
    if (ai && !def.aiCapable) add("ai_not_allowed", `${n.label}: this block is deterministic and cannot use AI`, { nodeId: n.id });
    if (def.aiRequired && !ai) add("ai_required", `${n.label}: this block always uses AI; set its execution to AI-assisted`, { nodeId: n.id });
    if (ai) aiCalls += 1;
    if ((ai || n.type === "final_synthesis") && !hasPrompt(n.prompt) && !def.defaultPrompt) add("prompt_required", `${n.label}: link a Prompt Builder prompt or write its prompt`, { nodeId: n.id });

    if (def.aiRequired && graph.nodes.filter((x) => x.type === n.type).length > 1 && graph.nodes.find((x) => x.type === n.type)?.id === n.id) {
      add("one_per_agent", `An agent can have only one ${def.label} block`, { nodeId: n.id });
    }
    if (n.type === "protocol_selection") {
      const detectors = graph.nodes.filter((x) => x.type === "anatomy_detection" && up.has(x.id));
      if (!detectors.length) add("anatomy_required", `${n.label}: needs an Anatomy detection block before it`, { nodeId: n.id });
      else if (n.knowledgeRevisionId && detectors.some((d) => d.knowledgeRevisionId !== n.knowledgeRevisionId)) {
        add("anatomy_knowledge", `${n.label}: use the same protocol table as the Anatomy detection block`, { nodeId: n.id });
      }
    }

    if (n.type === "final_synthesis") {
      const cats = n.outputCategories ?? [];
      if (!cats.length) add("outputs_required", `${n.label}: select the output categories`, { nodeId: n.id });
      for (const c of cats) if (!OUTPUT_CATEGORIES.includes(c as never)) add("output_unknown", `${n.label}: unknown output category "${c}"`, { nodeId: n.id });
    }
  }

  const maxAi = ctx.maxAiCalls ?? DEFAULT_MAX_AI_CALLS;
  if (aiCalls > maxAi) add("ai_budget", `The graph needs ${aiCalls} AI calls; the approved budget is ${maxAi}`);
  if (!hasPrompt(ctx.agentPrompt)) add("agent_prompt_required", "Write or link the agent instructions (purpose, population, permitted tasks)");

  // Prohibitions: deny wins; custom rules must be mapped and reviewed.
  const rules = effectiveRules(ctx.kind, ctx.prohibitions);
  for (const c of ctx.prohibitions.custom) {
    if (!c.binding) add("prohibition_unmapped", `Custom prohibition "${c.text}" is not mapped to a structured rule`);
    else if (!c.reviewed) add("prohibition_unreviewed", `Custom prohibition "${c.text}": a clinical reviewer must confirm its mapping`);
  }
  const denied = deniedOutputs(rules);
  for (const n of graph.nodes.filter((x) => x.type === "final_synthesis")) {
    for (const c of n.outputCategories ?? []) {
      if (denied.has(c)) add("output_prohibited", `${n.label}: "${c}" is prohibited for this agent`, { nodeId: n.id });
    }
  }

  // Voice: every path to booking passes the guards; confirmation (yes) immediately precedes booking.
  if (ctx.kind === "voice" && acyclic) {
    const must = new Map<string, Set<string>>(); // block types on every path from start
    for (const id of order) {
      const preds = inEdges.get(id) ?? [];
      let inter: Set<string> | null = null;
      for (const e of preds) {
        const s = must.get(e.from) ?? new Set<string>();
        const prev = inter as Set<string> | null;
        inter = prev === null ? new Set<string>(s) : new Set<string>([...prev].filter((x: string) => s.has(x)));
      }
      const set = inter ?? new Set<string>();
      set.add(nodes.get(id)!.type);
      must.set(id, set);
    }
    for (const n of graph.nodes.filter((x) => x.type === "book")) {
      const missing = VOICE_GUARDS.filter((g) => !must.get(n.id)?.has(g));
      if (missing.length) add("booking_guard", `${n.label}: some paths reach booking without ${missing.join(", ")}`, { nodeId: n.id });
      for (const e of inEdges.get(n.id) ?? []) {
        if (nodes.get(e.from)?.type !== "confirmation" || e.port !== "yes") {
          add("confirm_before_book", `${n.label}: booking must come directly after a confirmed read-back`, { nodeId: n.id, edgeId: e.id });
        }
      }
    }
  }
  return issues;
}

function conditionProblem(field: OutputField, operator: string, value: unknown): string | null {
  if (operator === "exists") return null;
  if (value === undefined || value === null || value === "") return "a comparison value is required";
  if (operator === "in") {
    if (!Array.isArray(value) || !value.length) return "use a list of values with \"in\"";
    if (field.values && value.some((v) => !field.values!.includes(String(v)))) return `values must be among ${field.values.join(", ")}`;
    return null;
  }
  if (["gt", "gte", "lt", "lte"].includes(operator)) {
    if (field.type === "number") return typeof value === "number" ? null : "compare a number with a number";
    if (field.type === "date") return /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? null : "compare a date with YYYY-MM-DD";
    return `"${operator}" needs a number or date field`;
  }
  if (field.type === "boolean") return typeof value === "boolean" ? null : "compare a yes/no field with true or false";
  if (field.type === "number") return typeof value === "number" ? null : "compare a number with a number";
  if (field.values && !field.values.includes(String(value))) return `value must be one of ${field.values.join(", ")}`;
  if (field.type === "list" || field.type === "record") return `"${operator}" can't compare a ${field.type}; use "exists"`;
  return null;
}

// ------------------------------------------------------------ manifest

/** JSON with sorted keys, so equal semantics give equal bytes. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export interface CompileResult {
  ok: boolean;
  issues: Issue[];
  manifest: Record<string, unknown> | null;
  manifestHash: string | null;
  preview: string[];
}

export function compile(graph: AgentGraph, ctx: CompileContext): CompileResult {
  const issues = validate(graph, ctx);
  const preview = previewLines(graph);
  if (issues.length) return { ok: false, issues, manifest: null, manifestHash: null, preview };

  const rules = effectiveRules(ctx.kind, ctx.prohibitions);
  const nodes = [...graph.nodes]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((n) => ({
      id: n.id,
      type: n.type,
      label: n.label.trim(),
      executionKind: n.executionKind ?? "deterministic",
      prompt: frozenPrompt(n),
      inputBindings: n.inputBindings ?? {},
      condition: n.condition ?? null,
      knowledgeRevisionId: n.knowledgeRevisionId ?? null,
      clinicProfileId: n.clinicProfileId ?? null,
      outputCategories: [...(n.outputCategories ?? [])].sort(),
    }));
  const edges = [...graph.edges].sort((a, b) => a.id.localeCompare(b.id)).map((e) => ({ id: e.id, from: e.from, port: e.port, to: e.to }));
  const manifest = {
    schemaVersion: "1.0",
    purpose: ctx.kind === "cds" ? "clinical_review" : "voice_scheduling",
    agentId: ctx.agentId,
    executionMode: ctx.executionMode,
    scope: ctx.scope,
    agentPrompt: ctx.agentPrompt ?? null,
    nodes,
    edges,
    sourceBindings: [...new Set(nodes.flatMap((n) => (n.knowledgeRevisionId ? [n.knowledgeRevisionId] : [])))].sort(),
    clinicProfiles: [...new Set(nodes.flatMap((n) => (n.clinicProfileId ? [n.clinicProfileId] : [])))].sort(),
    effectivePolicy: {
      platformRevision: PLATFORM_POLICY_REVISION,
      rules: rules.map((r) => ({ id: r.id, origin: r.origin, binding: r.binding })),
    },
    budget: { maxAiCalls: ctx.maxAiCalls ?? DEFAULT_MAX_AI_CALLS, aiCalls: nodes.filter((n) => n.executionKind === "ai").length },
    // Only versions with AI steps carry a model, so other versions keep their hash.
    ...(nodes.some((n) => n.executionKind === "ai") ? { aiModel: ctx.aiModel ?? null } : {}),
    missingDataPolicy: ctx.kind === "cds" ? "request_input" : "transfer_to_staff",
    outputPolicy: ctx.kind === "cds" ? "clinician_review_only" : "confirmed_booking_only",
  };
  const manifestHash = `sha256:${createHash("sha256").update(canonicalJson(manifest)).digest("hex")}`;
  return { ok: true, issues: [], manifest, manifestHash, preview };
}

/** The node's prompt as frozen; blocks with a built-in prompt get it when the author left it empty. */
function frozenPrompt(n: GraphNode): PromptRef | null {
  const fallback = BLOCK_BY_TYPE.get(n.type)?.defaultPrompt;
  if (fallback && !hasPrompt(n.prompt)) return { promptId: null, revisionId: null, draftText: fallback };
  return n.prompt ? { promptId: n.prompt.promptId ?? null, revisionId: n.prompt.revisionId ?? null, draftText: n.prompt.draftText?.trim() || null } : null;
}

/** Readable steps in execution order (documentation only). */
export function previewLines(graph: AgentGraph): string[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const lines: string[] = [];
  const seen = new Set<string>();
  const start = graph.nodes.find((n) => BLOCK_BY_TYPE.get(n.type)?.start);
  const queue = start ? [start.id] : [];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const n = byId.get(id);
    if (!n) continue;
    const def = BLOCK_BY_TYPE.get(n.type);
    let line = `${lines.length + 1}. ${n.label} (${def?.label ?? n.type}${n.executionKind === "ai" ? ", AI" : ""})`;
    if (n.condition) line += ` — if ${byId.get(n.condition.nodeId)?.label ?? n.condition.nodeId}.${n.condition.field} ${n.condition.operator}${n.condition.operator === "exists" ? "" : " " + JSON.stringify(n.condition.value)}`;
    const outs = graph.edges.filter((e) => e.from === id);
    if (outs.length > 1 || (outs[0] && outs[0].port !== "out")) {
      line += `; ${outs.map((e) => `${e.port} → ${byId.get(e.to)?.label ?? e.to}`).join(", ")}; unknown → ${n.type === "confirmation" || graph.nodes.some((x) => x.type === "book") ? "staff" : "pause for input"}`;
    }
    lines.push(line);
    for (const e of outs) queue.push(e.to);
  }
  return lines;
}
