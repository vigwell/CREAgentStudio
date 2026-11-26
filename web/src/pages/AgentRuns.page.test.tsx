import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import i18n from "../i18n";
import { setTokenProvider } from "../api/client";
import { AgentRuns } from "./AgentRuns";

const agent = { id: "a1", kind: "cds", name: "MRI protocol", intendedUse: "x", scope: {}, executionMode: "standalone_cds", draft: { version: 1, graph: { nodes: [], edges: [] }, agentPrompt: null, prohibitions: { optional: [], custom: [] } } };

function stub(inputFields: string[] | null) {
  setTokenProvider(async () => "t");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (url.endsWith("/agents/a1")) return json(agent);
      if (url.endsWith("/candidates")) return json({ candidates: [{ id: "c1", candidateNo: 1, manifestHash: "h", draftVersion: 1, status: "candidate", createdAt: "2026-11-26T10:00:00Z", inputFields }] });
      if (url.endsWith("/runs")) return json({ runs: [] });
      return json({});
    }),
  );
}

const page = () =>
  render(
    <MemoryRouter initialEntries={["/agents/a1/runs"]}>
      <Routes>
        <Route path="/agents/:agentId/runs" element={<AgentRuns />} />
      </Routes>
    </MemoryRouter>,
  );

describe("AgentRuns page", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("an MRI version shows only the referral, age and pediatric inputs, and the scan reader", async () => {
    stub(["ageYears", "pediatric", "clinicalNote"]);
    page();
    await waitFor(() => expect(screen.getByText("Pediatric patient")).toBeInTheDocument());
    expect(screen.getByText("Age (years)")).toBeInTheDocument();
    expect(screen.getByText("Clinical note / referral text")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Read a scanned referral" })).toBeInTheDocument();
    expect(screen.queryByText("eGFR")).toBeNull();
    expect(screen.queryByText("Indication code")).toBeNull();
  });

  it("other versions show every input", async () => {
    stub(null);
    page();
    await waitFor(() => expect(screen.getByText("eGFR")).toBeInTheDocument());
    expect(screen.getByText("Indication code")).toBeInTheDocument();
  });
});
