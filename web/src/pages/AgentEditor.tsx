import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Background, Controls, ReactFlow, applyNodeChanges, type Connection, type Edge, type NodeChange } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { api, ApiError, type Agent, type AgentDraft, type Catalog, type ClinicProfile, type CompileResult, type SourceSummary, type StudioUser } from "../api/client";
import { ErrorNote } from "../components/ErrorNote";
import { BlockNode, type BlockFlowNode } from "../agents/BlockNode";
import { Inspector } from "../agents/Inspector";
import { Prohibitions } from "../agents/Prohibitions";
import { addBlock, blockMap, connect, issuesByNode, paletteFor, removeBlocks, updateNode, type Graph } from "../agents/graph";

const nodeTypes = { block: BlockNode };
type Tab = "instructions" | "prohibitions" | "problems";

export function AgentEditor({ user }: { user: StudioUser }) {
  const { t } = useTranslation();
  const { agentId } = useParams();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const [sources, setSources] = useState<SourceSummary[]>([]);
  const [profiles, setProfiles] = useState<ClinicProfile[]>([]);
  const [compiled, setCompiled] = useState<CompileResult | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [rfNodes, setRfNodes] = useState<BlockFlowNode[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [tab, setTab] = useState<Tab>("problems");
  const readOnly = !(user.role === "admin" || user.role === "author");

  useEffect(() => {
    Promise.all([
      api<Catalog>("/agents/catalog"),
      api<Agent>(`/agents/${agentId}`),
      api<{ sources: SourceSummary[] }>("/knowledge/sources"),
      api<{ profiles: ClinicProfile[] }>("/clinic-profiles"),
    ])
      .then(([c, a, s, p]) => {
        setCatalog(c);
        setAgent(a);
        setDraft(a.draft);
        setSources(s.sources);
        setProfiles(p.profiles);
      })
      .catch(setError);
  }, [agentId]);

  const defs = useMemo(() => (catalog ? blockMap(catalog) : new Map()), [catalog]);
  const issues = useMemo(() => issuesByNode(compiled?.issues ?? []), [compiled]);
  const graph = draft?.graph;

  // Keep React Flow's own node state (measured size, selection) and refresh the block data from the draft.
  useEffect(() => {
    if (!graph) return;
    setRfNodes((prev) =>
      graph.nodes.map((n) => {
        const old = prev.find((p) => p.id === n.id);
        return {
          ...(old ?? {}),
          id: n.id,
          type: "block" as const,
          position: n.position ?? { x: 0, y: 0 },
          deletable: n.type !== "start" && !readOnly,
          data: { node: n, def: defs.get(n.type), issues: issues.get(n.id) ?? [] },
        };
      }),
    );
  }, [graph, defs, issues, readOnly]);

  const rfEdges: Edge[] = useMemo(
    () =>
      (graph?.edges ?? []).map((e) => ({
        id: e.id,
        source: e.from,
        sourceHandle: e.port,
        target: e.to,
        label: e.port === "out" ? undefined : e.port,
        deletable: !readOnly,
      })),
    [graph, readOnly],
  );

  const setGraph = useCallback((fn: (g: Graph) => Graph) => {
    setDraft((d) => (d ? { ...d, graph: fn(d.graph) } : d));
    setDirty(true);
    setNotice(null);
  }, []);

  const onNodesChange = useCallback(
    (changes: NodeChange<BlockFlowNode>[]) => {
      setRfNodes((nds) => applyNodeChanges(changes, nds));
      for (const c of changes) if (c.type === "select" && c.selected) setSelected(c.id);
      const removed = changes.filter((c) => c.type === "remove").map((c) => c.id);
      if (removed.length) setGraph((g) => removeBlocks(g, removed));
    },
    [setGraph],
  );

  const save = async (): Promise<AgentDraft | null> => {
    if (!draft || !agent) return null;
    setError(null);
    try {
      const r = await api<{ version: number }>(`/agents/${agent.id}/draft`, { method: "PUT", body: draft });
      const next = { ...draft, version: r.version };
      setDraft(next);
      setDirty(false);
      setNotice(t("editor.saved", { v: r.version }));
      return next;
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? new Error(t("editor.stale")) : err);
      return null;
    }
  };

  const run = async (what: "compile" | "freeze") => {
    if (!agent) return;
    setBusy(true);
    try {
      if (dirty && !(await save())) return;
      const c = await api<CompileResult>(`/agents/${agent.id}/compile`, { method: "POST" });
      setCompiled(c);
      setTab("problems");
      if (what === "freeze" && c.ok) {
        const cand = await api<{ candidateNo: number }>(`/agents/${agent.id}/candidates`, { method: "POST" });
        setNotice(t("editor.frozen", { no: cand.candidateNo }));
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (!catalog || !agent || !draft || !graph) return <ErrorNote error={error} />;
  const selectedNode = graph.nodes.find((n) => n.id === selected) ?? null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <Link to="/agents" className="text-sm text-slate-500 hover:underline">
            {t("agents.title")}
          </Link>
          <h1 className="text-2xl font-bold">{agent.name}</h1>
          <p className="text-sm text-slate-600">
            {t(`agents.${agent.kind}`)} · {t("agents.version", { v: draft.version })}
          </p>
        </div>
        <div className="ms-auto flex items-center gap-2">
          {notice && <span className="text-sm text-brand-strong">{notice}</span>}
          {agent.kind === "cds" && (
            <Link className="btn" to={`/agents/${agent.id}/runs`}>
              {t("runs.title")}
            </Link>
          )}
          {!readOnly && (
            <button className="btn" disabled={!dirty || busy} onClick={() => void save()}>
              {t("editor.save")}
            </button>
          )}
          <button className="btn" disabled={busy} onClick={() => void run("compile")}>
            {t("editor.compile")}
          </button>
          {!readOnly && (
            <button className="btn btn-primary" disabled={busy} onClick={() => void run("freeze")}>
              {t("editor.freeze")}
            </button>
          )}
        </div>
      </div>
      <ErrorNote error={error} />

      <div className="grid gap-4 lg:grid-cols-[180px_1fr_300px]">
        <div className="card space-y-2 p-3">
          <h2 className="label">{t("editor.blocks")}</h2>
          <p className="text-xs text-slate-500">{t("editor.addHint")}</p>
          {paletteFor(catalog, agent.kind).map((b) => (
            <button
              key={b.type}
              className="block w-full rounded-lg border border-slate-200 px-2 py-1.5 text-start text-sm hover:border-brand disabled:opacity-50"
              disabled={readOnly}
              onClick={() =>
                setGraph((g) => {
                  const r = addBlock(g, b);
                  setSelected(r.id);
                  return r.graph;
                })
              }
            >
              {b.label}
            </button>
          ))}
        </div>

        <div className="card h-[560px] p-0" dir="ltr">
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onNodeDragStop={(_, n) =>
              setGraph((g) => updateNode(g, n.id, { position: { x: Math.round(n.position.x), y: Math.round(n.position.y) } }))
            }
            onEdgesChange={(changes) => {
              const removed = new Set(changes.filter((c) => c.type === "remove").map((c) => c.id));
              if (removed.size) setGraph((g) => ({ ...g, edges: g.edges.filter((e) => !removed.has(e.id)) }));
            }}
            onConnect={(c: Connection) => {
              if (c.source && c.target) setGraph((g) => connect(g, c.source, c.sourceHandle ?? "out", c.target));
            }}
            onPaneClick={() => setSelected(null)}
            nodesDraggable={!readOnly}
            nodesConnectable={!readOnly}
            deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
            fitView
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>

        <div className="card p-4">
          <h2 className="label mb-3">{t("editor.inspector")}</h2>
          {selectedNode ? (
            <Inspector
              graph={graph}
              node={selectedNode}
              defs={defs}
              catalog={catalog}
              sources={sources}
              profiles={profiles}
              issues={issues.get(selectedNode.id) ?? []}
              readOnly={readOnly}
              onChange={(patch) => setGraph((g) => updateNode(g, selectedNode.id, patch))}
              onDelete={() => {
                setGraph((g) => removeBlocks(g, [selectedNode.id]));
                setSelected(null);
              }}
            />
          ) : (
            <p className="text-sm text-slate-500">{t("editor.noSelection")}</p>
          )}
        </div>
      </div>

      <div className="card">
        <div className="mb-4 flex gap-4 border-b border-slate-200 text-sm font-medium" role="tablist">
          {(["problems", "instructions", "prohibitions"] as Tab[]).map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={tab === k}
              className={`-mb-px border-b-2 pb-2 ${tab === k ? "border-brand text-brand-strong" : "border-transparent text-slate-500"}`}
              onClick={() => setTab(k)}
            >
              {k === "problems" ? t("editor.tabProblems") : k === "instructions" ? t("editor.tabInstructions") : t("editor.tabProhibitions")}
            </button>
          ))}
        </div>

        {tab === "instructions" && (
          <fieldset disabled={readOnly} className="space-y-2">
            <label className="block">
              <span className="label">{t("editor.agentPrompt")}</span>
              <textarea
                className="input"
                rows={6}
                value={draft.agentPrompt?.draftText ?? ""}
                onChange={(e) => {
                  setDraft({ ...draft, agentPrompt: { ...draft.agentPrompt, draftText: e.target.value || null } });
                  setDirty(true);
                }}
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label>
                <span className="label">{t("editor.promptId")}</span>
                <input
                  className="input"
                  value={draft.agentPrompt?.promptId ?? ""}
                  onChange={(e) => {
                    setDraft({ ...draft, agentPrompt: { ...draft.agentPrompt, promptId: e.target.value || null } });
                    setDirty(true);
                  }}
                />
              </label>
              <label>
                <span className="label">{t("editor.promptRev")}</span>
                <input
                  className="input"
                  value={draft.agentPrompt?.revisionId ?? ""}
                  onChange={(e) => {
                    setDraft({ ...draft, agentPrompt: { ...draft.agentPrompt, revisionId: e.target.value || null } });
                    setDirty(true);
                  }}
                />
              </label>
            </div>
          </fieldset>
        )}

        {tab === "prohibitions" && (
          <Prohibitions
            kind={agent.kind}
            catalog={catalog}
            value={draft.prohibitions}
            readOnly={readOnly}
            onChange={(p) => {
              setDraft({ ...draft, prohibitions: p });
              setDirty(true);
            }}
          />
        )}

        {tab === "problems" &&
          (compiled ? (
            <div className="space-y-4 text-sm">
              {compiled.ok ? (
                <p className="font-medium text-brand-strong">{t("editor.noProblems")}</p>
              ) : (
                <div>
                  <p className="mb-2 font-medium text-red-700">{t("editor.problems", { count: compiled.issues.length })}</p>
                  <ul className="space-y-1">
                    {compiled.issues.map((i, k) => (
                      <li key={k}>
                        <button className="text-start hover:underline" onClick={() => i.nodeId && setSelected(i.nodeId)}>
                          <span className="font-mono text-xs text-slate-400">{i.code}</span> {i.message}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {compiled.manifestHash && (
                <p>
                  <span className="label">{t("editor.hash")}</span>
                  <code className="break-all text-xs">{compiled.manifestHash}</code>
                </p>
              )}
              <div>
                <span className="label">{t("editor.preview")}</span>
                <pre className="whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs" dir="ltr">
                  {compiled.preview.join("\n")}
                </pre>
              </div>
            </div>
          ) : (
            <p className="text-sm text-slate-500">{t("editor.notCompiled")}</p>
          ))}
      </div>
    </div>
  );
}
