import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import type { BlockDef, GraphNode, Issue } from "../api/client";

export type BlockNodeData = { node: GraphNode; def: BlockDef | undefined; issues: Issue[] };
export type BlockFlowNode = Node<BlockNodeData, "block">;

/** One block on the canvas: input on the left, one exit per port on the right. */
export function BlockNode({ data, selected }: NodeProps<BlockFlowNode>) {
  const { node, def, issues } = data;
  const ports = def?.ports ?? [];
  const tone = def?.start ? "border-brand" : def?.terminal ? "border-slate-500" : node.type === "decision" ? "border-amber-400" : "border-slate-300";
  return (
    <div
      className={`min-w-[170px] rounded-xl border-2 bg-white px-3 py-2 text-start shadow-sm ${tone} ${selected ? "ring-2 ring-brand/40" : ""} ${
        issues.length ? "!border-red-400" : ""
      }`}
    >
      {!def?.start && <Handle type="target" position={Position.Left} />}
      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{def?.label ?? node.type}</div>
      <div className="text-sm font-semibold text-slate-800">{node.label}</div>
      <div className="mt-1 flex flex-wrap gap-1">
        {node.executionKind === "ai" && <span className="rounded bg-violet-100 px-1.5 text-[10px] font-semibold text-violet-700">AI</span>}
        {issues.length > 0 && <span className="rounded bg-red-100 px-1.5 text-[10px] font-semibold text-red-700">{issues.length} !</span>}
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
          {ports.length > 1 && <span className="pointer-events-none absolute start-3 -top-2 text-[10px] font-semibold text-slate-500">{p}</span>}
        </Handle>
      ))}
    </div>
  );
}
