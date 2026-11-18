/**
 * Heavy screens load on demand (the graph editor carries React Flow), and are
 * warmed up when the user points at a link to them.
 */
import { lazy } from "react";
import { prefetch } from "../api/query";

export const loadEditor = () => import("./AgentEditor");
export const AgentEditorPage = lazy(() => loadEditor().then((m) => ({ default: m.AgentEditor })));

/** Hover / focus on a link to an agent: code and data are ready by the click. */
export function warmAgent(agentId: string) {
  void loadEditor();
  for (const key of [`/agents/${agentId}`, "/agents/catalog", "/knowledge/sources", "/clinic-profiles"]) prefetch(key);
}
