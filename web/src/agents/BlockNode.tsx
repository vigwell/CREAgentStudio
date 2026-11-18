import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import type { BlockDef, GraphNode, Issue } from "../api/client";

export type BlockNodeData = { node: GraphNode; def: BlockDef | undefined; issues: Issue[] };
export type BlockFlowNode = Node<BlockNodeData, "block">;

/** One block on the canvas: input on the left, one exit per port on the right. */
export function BlockNode({ data, selected }: NodeProps<BlockFlowNode>) {
  const { node, def, issues } = data;
  const ports = def?.ports ?? [];
  const tone = def?.start ? "border-accent" : def?.terminal ? "border-line-strong" : node.type === "decision" ? "border-warning" : "border-line-strong";
  return (
    <div
      className={`min-w-[170px] rounded-panel border-2 bg-surface px-3 py-2 text-start shadow-sm ${tone} ${selected ? "ring-2 ring-accent/40" : ""} ${
        issues.length ? "!border-danger/40" : ""
      }`}
    >
      {!def?.start && <Handle type="target" position={Position.Left} />}
      <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-subtle">{def?.label ?? node.type}</div>
      <div className="text-sm font-semibold text-ink">{node.label}</div>
      <div className="mt-1 flex flex-wrap gap-1">
        {node.executionKind === "ai" && <span className="rounded bg-ai-soft px-1.5 text-[10px] font-semibold text-ai">AI</span>}
        {issues.length > 0 && <span className="rounded bg-danger-soft px-1.5 text-[10px] font-semibold text-danger">{issues.length} !</span>}
      </div>
      {ports.map((p, i) => (
        <Handle
          key={p}
          id={p}
          type="source"
          position={Position.Right}
          style={{ top: `${((i + 1) / (ports.length + 1)) * 100}%` }}
          title={p}
        >
          {ports.length > 1 && <span className="pointer-events-none absolute start-3 -top-2 text-[10px] font-semibold text-ink-subtle">{p}</span>}
        </Handle>
      ))}
    </div>
  );
}
