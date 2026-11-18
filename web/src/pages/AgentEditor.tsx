import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Background, Controls, ReactFlow, applyNodeChanges, type Connection, type Edge, type NodeChange } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { api, ApiError, type Agent, type AgentDraft, type Catalog, type ClinicProfile, type CompileResult, type SourceSummary, type StudioUser } from "../api/client";
import { ErrorNote } from "../components/ErrorNote";
import { invalidate, setQueryData, useQuery } from "../api/query";
import { EditorSkeleton } from "../ui/Skeleton";
import { FlaskConical, ListChecks, Plus, Save, Snowflake } from "lucide-react";
import { PageHeader } from "../ui/PageHeader";
import { StatusPill } from "../ui/StatusPill";
import { useDarkTheme, useMedia } from "../ui/useMedia";
import { BlockNode, type BlockFlowNode } from "../agents/BlockNode";
import { Inspector } from "../agents/Inspector";
import { Prohibitions } from "../agents/Prohibitions";
import { addBlock, blockLabel, blockMap, connect, issuesByNode, paletteFor, removeBlocks, updateNode, type Graph } from "../agents/graph";
import { Field } from "../ui/Field";

const nodeTypes = { block: BlockNode };
type Tab = "instructions" | "prohibitions" | "problems";

export function AgentEditor({ user }: { user: StudioUser }) {
  const { t } = useTranslation();
  const { agentId } = useParams();
  const catalogQ = useQuery<Catalog>("/agents/catalog");
  const agentQ = useQuery<Agent>(`/agents/${agentId}`);
  const sourcesQ = useQuery<{ sources: SourceSummary[] }>("/knowledge/sources");
  const profilesQ = useQuery<{ profiles: ClinicProfile[] }>("/clinic-profiles");
  const catalog = catalogQ.data ?? null;
  const agent = agentQ.data ?? null;
  const sources = sourcesQ.data?.sources ?? [];
  const profiles = profilesQ.data?.profiles ?? [];
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const [pending, setPending] = useState<"save" | "compile" | "freeze" | null>(null);
  const [compiled, setCompiled] = useState<CompileResult | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [rfNodes, setRfNodes] = useState<BlockFlowNode[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [tab, setTab] = useState<Tab>("problems");
  const isPhone = useMedia("(max-width: 767px)");
  const dark = useDarkTheme();
  const canEdit = user.role === "admin" || user.role === "author";
  // The graph is edited on a tablet or desktop; on a phone it is read-only (review, problems, runs).
  const readOnly = !canEdit || isPhone;

  // The draft is edited locally; it is taken from the server once per agent (never over unsaved edits).
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (agent && loadedFor.current !== agent.id) {
      loadedFor.current = agent.id;
      setDraft(agent.draft);
      setDirty(false);
    }
  }, [agent]);

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
    setPending((p) => p ?? "save");
    try {
      const r = await api<{ version: number }>(`/agents/${agent.id}/draft`, { method: "PUT", body: draft });
      const next = { ...draft, version: r.version };
      setDraft(next);
      setDirty(false);
      setNotice(t("editor.saved", { v: r.version }));
      // Keep the cache in step, so coming back to this agent opens the saved draft instantly.
      setQueryData<Agent>(`/agents/${agent.id}`, (old) => (old ? { ...old, draft: next } : old!));
      invalidate("/agents");
      return next;
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? new Error(t("editor.stale")) : err);
      return null;
    } finally {
      setPending((p) => (p === "save" ? null : p));
    }
  };

  // Ctrl/⌘ S saves.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const run = async (what: "compile" | "freeze") => {
    if (!agent) return;
    setBusy(true);
    setPending(what);
    try {
      if (dirty && !(await save())) return;
      const c = await api<CompileResult>(`/agents/${agent.id}/compile`, { method: "POST" });
      setCompiled(c);
      setTab("problems");
      if (what === "freeze" && c.ok) {
        const cand = await api<{ candidateNo: number }>(`/agents/${agent.id}/candidates`, { method: "POST" });
        invalidate(`/agents/${agent.id}/candidates`);
        invalidate("/agents");
        setNotice(t("editor.frozen", { no: cand.candidateNo }));
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const loadError = error ?? catalogQ.error ?? agentQ.error;
  if (!catalog || !agent || !draft || !graph) return loadError ? <ErrorNote error={loadError} /> : <EditorSkeleton />;
  const selectedNode = graph.nodes.find((n) => n.id === selected) ?? null;

  return (
    <div className="space-y-4">
      <PageHeader
        back={{ to: "/agents", label: t("agents.title") }}
        title={agent.name}
        meta={
          <>
            <StatusPill tone={agent.kind === "cds" ? "info" : "ai"}>{t(`agents.${agent.kind}`)}</StatusPill>
            <span>{t("agents.version", { v: draft.version })}</span>
            {dirty && <StatusPill tone="warning">{t("editor.unsaved")}</StatusPill>}
            {notice && <span className="text-accent">{notice}</span>}
          </>
        }
        actions={
          <>
            {agent.kind === "cds" && (
              <Link className="btn" to={`/agents/${agent.id}/runs`}>
                <FlaskConical size={16} />
                {t("runs.title")}
              </Link>
            )}
            {!readOnly && (
              <button className="btn" disabled={!dirty || busy} onClick={() => void save()}>
                <Save size={16} />
                {pending === "save" ? t("editor.saving") : t("editor.save")}
              </button>
            )}
            <button className="btn" disabled={busy} onClick={() => void run("compile")}>
              <ListChecks size={16} />
              {pending === "compile" ? t("editor.compiling") : t("editor.compile")}
            </button>
            {!readOnly && (
              <button className="btn btn-primary" disabled={busy} onClick={() => void run("freeze")}>
                <Snowflake size={16} />
                {pending === "freeze" ? t("editor.freezing") : t("editor.freeze")}
              </button>
            )}
          </>
        }
      />
      {isPhone && canEdit && (
        <p className="rounded-control border border-info/30 bg-info-soft px-3 py-2 text-sm text-info">{t("editor.phoneReadOnly")}</p>
      )}
      <ErrorNote error={error} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[240px_minmax(0,1fr)_300px]">
        <div className={`card p-3 ${readOnly ? "hidden lg:block" : ""}`}>
          <h2 className="label">{t("editor.blocks")}</h2>
          <p className="mb-2 text-caption text-ink-subtle">{t("editor.addHint")}</p>
          <div className="flex flex-wrap gap-2 lg:flex-col lg:gap-1.5">
          {paletteFor(catalog, agent.kind).map((b) => (
            <button
              key={b.type}
              title={blockLabel(t, b)}
              className="inline-flex h-9 min-w-0 items-center gap-2 rounded-control border border-line bg-surface px-3 text-start text-sm text-ink hover:border-accent hover:bg-accent-soft disabled:cursor-not-allowed disabled:text-ink-subtle lg:w-full"
              disabled={readOnly}
              onClick={() =>
                setGraph((g) => {
                  const r = addBlock(g, { ...b, label: blockLabel(t, b) });
                  setSelected(r.id);
                  return r.graph;
                })
              }
            >
              <Plus size={14} className="shrink-0 text-ink-subtle" />
              <span className="truncate">{blockLabel(t, b)}</span>
            </button>
          ))}
          </div>
        </div>

        <div className="card h-[420px] overflow-hidden p-0 md:h-[600px]" dir="ltr">
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
            fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
            minZoom={0.15}
            colorMode={dark ? "dark" : "light"}
            proOptions={{ hideAttribution: false }}
          >
            <Background gap={20} size={1} />
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
            <p className="text-sm text-ink-subtle">{t("editor.noSelection")}</p>
          )}
        </div>
      </div>

      <div className="card">
        <div className="-mx-1 mb-4 flex gap-5 overflow-x-auto border-b border-line px-1 text-sm font-medium" role="tablist">
          {(["problems", "instructions", "prohibitions"] as Tab[]).map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={tab === k}
              className={`-mb-px shrink-0 whitespace-nowrap border-b-2 pb-2 ${tab === k ? "border-accent text-accent" : "border-transparent text-ink-subtle"}`}
              onClick={() => setTab(k)}
            >
              {k === "problems" ? t("editor.tabProblems") : k === "instructions" ? t("editor.tabInstructions") : t("editor.tabProhibitions")}
            </button>
          ))}
        </div>

        {tab === "instructions" && (
          <fieldset disabled={readOnly} className="space-y-2">
            <Field label={t("editor.agentPrompt")}>
              <textarea
                className="input"
                rows={6}
                value={draft.agentPrompt?.draftText ?? ""}
                onChange={(e) => {
                  setDraft({ ...draft, agentPrompt: { ...draft.agentPrompt, draftText: e.target.value || null } });
                  setDirty(true);
                }}
              />
            </Field>
            <div className="field-grid sm:grid-cols-2">
              <Field label={t("editor.promptId")}>
                <input
                  className="input"
                  value={draft.agentPrompt?.promptId ?? ""}
                  onChange={(e) => {
                    setDraft({ ...draft, agentPrompt: { ...draft.agentPrompt, promptId: e.target.value || null } });
                    setDirty(true);
                  }}
                />
              </Field>
              <Field label={t("editor.promptRev")}>
                <input
                  className="input"
                  value={draft.agentPrompt?.revisionId ?? ""}
                  onChange={(e) => {
                    setDraft({ ...draft, agentPrompt: { ...draft.agentPrompt, revisionId: e.target.value || null } });
                    setDirty(true);
                  }}
                />
              </Field>
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
                <p className="font-medium text-accent">{t("editor.noProblems")}</p>
              ) : (
                <div>
                  <p className="mb-2 font-medium text-danger">{t("editor.problems", { count: compiled.issues.length })}</p>
                  <ul className="space-y-1">
                    {compiled.issues.map((i, k) => (
                      <li key={k}>
                        <button className="text-start hover:underline" onClick={() => i.nodeId && setSelected(i.nodeId)}>
                          {i.message}
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
                <pre className="whitespace-pre-wrap rounded-control bg-surface-sunken p-3 text-xs" dir="ltr">
                  {compiled.preview.join("\n")}
                </pre>
              </div>
            </div>
          ) : (
            <p className="text-sm text-ink-subtle">{t("editor.notCompiled")}</p>
          ))}
      </div>
    </div>
  );
}
