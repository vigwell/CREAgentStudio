/** Pure helpers for the agent editor: catalog lookups, graph edits and issue grouping. */
import type { AgentKind, BlockDef, Catalog, GraphEdge, GraphNode, Issue } from "../api/client";

export type Graph = { nodes: GraphNode[]; edges: GraphEdge[] };

export function blockMap(catalog: Catalog): Map<string, BlockDef> {
  return new Map(catalog.blocks.map((b) => [b.type, b]));
}

/** Blocks an author may add to an agent of this kind (one Start per graph). */
export function paletteFor(catalog: Catalog, kind: AgentKind): BlockDef[] {
  return catalog.blocks.filter((b) => b.kinds.includes(kind) && !b.start);
}

function nextId(graph: Graph, type: string): string {
  const used = new Set(graph.nodes.map((n) => n.id));
  for (let i = 1; ; i++) {
    const id = `${type}-${i}`;
    if (!used.has(id)) return id;
  }
}

/** Adds a block below the lowest one so it never lands on top of another. */
export function addBlock(graph: Graph, def: BlockDef): { graph: Graph; id: string } {
  const id = nextId(graph, def.type);
  const maxY = graph.nodes.reduce((m, n) => Math.max(m, n.position?.y ?? 0), 0);
  const node: GraphNode = {
    id,
    type: def.type,
    label: def.label,
    position: { x: 300, y: maxY + 140 },
    ...(def.aiCapable ? { executionKind: def.aiRequired ? ("ai" as const) : ("deterministic" as const) } : {}),
    // Blocks with a built-in prompt start with it, so the author sees and can adjust it.
    ...(def.defaultPrompt ? { prompt: { promptId: null, revisionId: null, draftText: def.defaultPrompt } } : {}),
  };
  return { graph: { ...graph, nodes: [...graph.nodes, node] }, id };
}

/** Each exit port leads to exactly one block: a new connection replaces the old one. */
export function connect(graph: Graph, from: string, port: string, to: string): Graph {
  if (from === to) return graph;
  const edges = graph.edges.filter((e) => !(e.from === from && e.port === port));
  return { ...graph, edges: [...edges, { id: `e-${from}-${port}-${to}`, from, port, to }] };
}

export function removeBlocks(graph: Graph, ids: string[]): Graph {
  const gone = new Set(ids.filter((id) => graph.nodes.find((n) => n.id === id)?.type !== "start"));
  return {
    nodes: graph.nodes.filter((n) => !gone.has(n.id)),
    edges: graph.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to)),
  };
}

export function updateNode(graph: Graph, id: string, patch: Partial<GraphNode>): Graph {
  return { ...graph, nodes: graph.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) };
}

/** Blocks that run before this one on some path: the only ones it may read from. */
export function upstreamOf(graph: Graph, id: string): GraphNode[] {
  const seen = new Set<string>();
  const queue = [id];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of graph.edges) {
      if (e.to === cur && !seen.has(e.from) && e.from !== id) {
        seen.add(e.from);
        queue.push(e.from);
      }
    }
  }
  return graph.nodes.filter((n) => seen.has(n.id));
}

export function issuesByNode(issues: Issue[]): Map<string, Issue[]> {
  const m = new Map<string, Issue[]>();
  for (const i of issues) {
    if (!i.nodeId) continue;
    m.set(i.nodeId, [...(m.get(i.nodeId) ?? []), i]);
  }
  return m;
}

/** Turns a typed condition value from the inspector into what the compiler expects. */
export function parseConditionValue(raw: string, fieldType: string | undefined, operator: string): unknown {
  if (operator === "exists") return undefined;
  if (operator === "in") return raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (fieldType === "number") return raw === "" ? "" : Number(raw);
  if (fieldType === "boolean") return raw === "true" ? true : raw === "false" ? false : raw;
  return raw;
}

export function formatConditionValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ");
  if (value === undefined || value === null) return "";
  return String(value);
}

/** Block type name in the UI language (falls back to the catalog's English label). */
export function blockLabel(t: (key: string, opts?: Record<string, unknown>) => string, def: { type: string; label: string } | undefined, type?: string): string {
  if (!def) return type ?? "";
  return t(`blocks.${def.type}`, { defaultValue: def.label });
}
