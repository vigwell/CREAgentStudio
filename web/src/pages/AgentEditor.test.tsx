import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import "../i18n";
import { setTokenProvider } from "../api/client";
import { AgentEditor } from "./AgentEditor";

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const catalog = {
  blocks: [
    { type: "start", kinds: ["cds", "voice"], label: "Start", ports: ["out"], outputs: [{ name: "caseId", type: "code" }], aiCapable: false, start: true },
    { type: "decision", kinds: ["cds", "voice"], label: "Decision", ports: ["yes", "no"], outputs: [{ name: "result", type: "boolean" }], aiCapable: false },
    { type: "final_synthesis", kinds: ["cds"], label: "Final synthesis", ports: [], outputs: [], aiCapable: true, terminal: true },
  ],
  operators: ["eq", "exists"],
  mandatoryRules: [{ id: "P01", text: "Create orders.", kinds: ["cds"], locked: true, binding: { type: "deny_capability", capability: "clinical_write" } }],
  optionalRules: [],
  outputCategories: ["missing_data_notice"],
};
const agent = {
  id: "a1",
  kind: "cds",
  name: "Contrast check",
  intendedUse: "Before CT",
  scope: {},
  executionMode: "standalone_cds",
  draft: {
    version: 3,
    graph: {
      nodes: [
        { id: "start", type: "start", label: "Request", position: { x: 0, y: 0 } },
        { id: "final", type: "final_synthesis", label: "Review summary", executionKind: "ai", position: { x: 300, y: 0 } },
      ],
      edges: [{ id: "e1", from: "start", port: "out", to: "final" }],
    },
    agentPrompt: null,
    prohibitions: { optional: [], custom: [] },
  },
};

let calls: { method: string; url: string; body: unknown }[] = [];

beforeEach(() => {
  calls = [];
  vi.stubGlobal("ResizeObserver", RO);
  setTokenProvider(async () => "t");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const method = init.method ?? "GET";
      calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : null });
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
      if (url.endsWith("/agents/catalog")) return json(catalog);
      if (url.endsWith("/agents/a1") && method === "GET") return json(agent);
      if (url.endsWith("/knowledge/sources")) return json({ sources: [] });
      if (url.endsWith("/clinic-profiles")) return json({ profiles: [] });
      if (url.endsWith("/draft")) return json({ version: 4 });
      if (url.endsWith("/compile"))
        return json({ ok: false, issues: [{ code: "missing_prompt", message: "Review summary needs a prompt", nodeId: "final" }], manifest: null, manifestHash: null, preview: ["1. Request"], draftVersion: 4 });
      return json({}, 404);
    }),
  );
});

function renderEditor() {
  return render(
    <MemoryRouter initialEntries={["/agents/a1"]}>
      <Routes>
        <Route path="/agents/:agentId" element={<AgentEditor user={{ id: "u1", tenantId: "t", email: null, displayName: null, role: "author" }} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("AgentEditor", () => {
  it("adds a block, saves with the loaded version, then compiles and lists problems", async () => {
    renderEditor();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Contrast check" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Decision" }));
    expect(screen.getByDisplayValue("Decision")).toBeInTheDocument(); // inspector opened on the new block

    fireEvent.click(screen.getByRole("button", { name: "Compile" }));
    await waitFor(() => expect(screen.getByText("Review summary needs a prompt")).toBeInTheDocument());

    const put = calls.find((c) => c.method === "PUT")!;
    const body = put.body as { version: number; graph: { nodes: { type: string }[] } };
    expect(body.version).toBe(3);
    expect(body.graph.nodes.map((n) => n.type)).toContain("decision");
    expect(screen.getByText("Draft 4", { exact: false })).toBeInTheDocument();
  });

  it("shows the locked platform prohibitions", async () => {
    renderEditor();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Contrast check" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("tab", { name: "Prohibitions" }));
    expect(screen.getByText("Create orders.")).toBeInTheDocument();
  });
});
