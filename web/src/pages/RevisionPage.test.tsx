import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import "../i18n";
import { setTokenProvider } from "../api/client";
import { RevisionPage } from "./RevisionPage";

const revision = {
  id: "r1",
  sourceId: "s1",
  sourceName: "CT 01 protocols",
  kind: "device_protocol",
  revisionNo: 2,
  status: "in_review",
  sheet: "CT 01",
  headerRow: 2,
  mapping: { Protocol: "protocolCode" },
  scope: { modality: "CT" },
  clinicalOwner: "Dr Demo",
  effectiveFrom: null,
  reviewDue: "2099-01-01",
  rowCount: 1,
  errorCount: 0,
  rowsSha256: "a".repeat(64),
  createdBy: "author-1",
  approvedBy: null,
  rows: [{ rowId: "CT 01!3", originalRow: 3, cells: {}, mapped: { protocolCode: "CT-HEAD-01" }, errors: [] }],
};

function renderAs(userId: string, role: "approver" | "viewer") {
  return render(
    <MemoryRouter initialEntries={["/knowledge/revisions/r1"]}>
      <Routes>
        <Route path="/knowledge/revisions/:revisionId" element={<RevisionPage user={{ id: userId, tenantId: "t", email: null, displayName: null, role }} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("RevisionPage", () => {
  beforeEach(() => {
    setTokenProvider(async () => "token");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(revision), { status: 200 })));
  });

  it("an approver who is not the author can approve", async () => {
    renderAs("approver-2", "approver");
    await waitFor(() => expect(screen.getByText("CT-HEAD-01")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
  });

  it("the author cannot approve their own revision", async () => {
    renderAs("author-1", "approver");
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled());
  });

  it("a viewer sees no actions", async () => {
    renderAs("viewer-3", "viewer");
    await waitFor(() => expect(screen.getByText("CT-HEAD-01")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });
});
