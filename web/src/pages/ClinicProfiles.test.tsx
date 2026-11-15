import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "../i18n";
import { setTokenProvider } from "../api/client";
import { ClinicProfiles, questionsFromText } from "./ClinicProfiles";

const profile = {
  id: "p1",
  profileKey: "k1",
  revisionNo: 1,
  name: "CT chest with contrast",
  site: "Main",
  department: "CT",
  subdepartment: null,
  risProcedureCode: "CT-CHEST-C",
  protocolCode: null,
  questions: [{ id: "q1", text: "Allergy to contrast?", answerType: "yes_no" }],
  horizonDays: 30,
  status: "draft",
  createdBy: "author-1",
};

function mockFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ profiles: [profile] }), { status: 200 })),
  );
}

describe("ClinicProfiles", () => {
  beforeEach(() => {
    setTokenProvider(async () => "t");
    mockFetch();
  });

  it("turns lines into yes/no questions", () => {
    expect(questionsFromText("Pregnant?\n\n  Pacemaker? ")).toEqual([
      { id: "q1", text: "Pregnant?", answerType: "yes_no" },
      { id: "q2", text: "Pacemaker?", answerType: "yes_no" },
    ]);
  });

  it("an independent approver can approve a draft", async () => {
    render(<ClinicProfiles user={{ id: "approver-1", tenantId: "t", email: null, displayName: null, role: "approver" }} />);
    await waitFor(() => expect(screen.getByText("CT chest with contrast")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  });

  it("the author cannot approve their own profile", async () => {
    render(<ClinicProfiles user={{ id: "author-1", tenantId: "t", email: null, displayName: null, role: "admin" }} />);
    await waitFor(() => expect(screen.getByText("CT chest with contrast")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });
});
