import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import "../i18n";
import { setTokenProvider } from "../api/client";
import { AgentRelease } from "./AgentRelease";

const agent = {
  id: "a1", kind: "cds", name: "Referral check", intendedUse: "x", scope: {}, executionMode: "standalone_cds",
  draft: { version: 2, graph: { nodes: [{ id: "has", type: "decision", label: "Indication present?" }], edges: [] }, agentPrompt: null, prohibitions: { optional: [], custom: [] } },
};
const versions = [
  { id: "c2", candidateNo: 2, manifestHash: "h2", draftVersion: 2, status: "candidate", statusReason: null, createdBy: "author", createdAt: "2026-11-12T10:00:00Z", approvedBy: null, approvedAt: null, activatedAt: null, lastTest: { id: "t", passed: true, caseCount: 2, failedCount: 0, at: "2026-11-12T10:05:00Z" } },
  { id: "c1", candidateNo: 1, manifestHash: "h1", draftVersion: 1, status: "active", statusReason: null, createdBy: "author", createdAt: "2026-11-11T10:00:00Z", approvedBy: "approver", approvedAt: null, activatedAt: null, lastTest: null },
];
const testRun = { id: "t", candidateId: "c2", passed: false, caseCount: 1, failedCount: 1, results: [{ testCaseId: "x", name: "Missing indication", passed: false, problems: [{ kind: "outcome", expected: "needs_input", actual: "findings" }], actual: {} }] };
let calls: { method: string; url: string }[] = [];

beforeEach(() => {
  calls = [];
  setTokenProvider(async () => "t");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url });
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (url.endsWith("/agents/a1")) return json(agent);
      if (url.endsWith("/versions")) return json({ versions });
      if (url.endsWith("/test-cases")) return json({ testCases: [] });
      if (url.endsWith("/candidates/c2/tests") && method === "GET") return json({ testRun });
      return json({ ok: true });
    }),
  );
});

function renderAs(id: string, role: "approver" | "author") {
  return render(
    <MemoryRouter initialEntries={["/agents/a1/release"]}>
      <Routes>
        <Route path="/agents/:agentId/release" element={<AgentRelease user={{ id, tenantId: "t", email: null, displayName: null, role }} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("AgentRelease", () => {
  it("an independent approver can approve a tested candidate; the author cannot", async () => {
    renderAs("approver", "approver");
    await waitFor(() => expect(screen.getByText("Version 2")).toBeInTheDocument());
    const approve = screen.getByRole("button", { name: "Approve" });
    expect(approve).toBeEnabled();
    fireEvent.click(approve);
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/candidates/c2/approve"))).toBe(true));
  });

  it("the author sees approval locked on their own version", async () => {
    renderAs("author", "approver");
    await waitFor(() => expect(screen.getByText("Version 2")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
  });

  it("test results explain each failure in words", async () => {
    renderAs("approver", "approver");
    await waitFor(() => expect(screen.getByText("Version 2")).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: "Results" })[0]);
    await waitFor(() => expect(screen.getByText("Result: expected Needs input, got Findings")).toBeInTheDocument());
  });

  it("withdrawing asks for a reason first", async () => {
    renderAs("approver", "approver");
    await waitFor(() => expect(screen.getByText("Version 2")).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: "Withdraw" })[0]);
    const input = screen.getByLabelText("Reason to withdraw");
    const submit = input.closest("form")!.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submit).toBeDisabled();
    fireEvent.change(input, { target: { value: "Wrong table" } });
    expect(submit).toBeEnabled();
  });
});
