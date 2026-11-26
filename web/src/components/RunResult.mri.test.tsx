import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import i18n from "../i18n";
import { RunResult } from "./RunResult";
import type { RunDetail } from "../api/client";

const run = {
  runId: "r1",
  agentId: "a1",
  caseRef: "MRI-1",
  candidateNo: 1,
  createdAt: "2026-11-25T10:00:00Z",
  purpose: "test",
  state: "completed",
  outcome: "findings",
  missingInputs: [],
  blockedFindings: [],
  reviews: [],
  summary: null,
  manifestHash: "sha256:x",
  snapshotHash: "sha256:y",
  findings: [
    {
      code: "PROTOCOL_SELECTED",
      category: "protocol_match",
      severity: "review",
      title: "Review selected protocol 310",
      detail: "כאב כתף ממושך ללא ניתוח קודם.",
      nodeId: "sel",
      observedInputs: [{ field: "anatomy", value: "כתף - מערכת השלד והשרירים", sourceRef: "clinicalNote", observedAt: null, attribution: "ai" }],
      evidence: [{ knowledgeRevisionId: "rev", sourceName: "MRI protocols V2", rowId: "Protocols!4", sheet: "Protocols", sourceRow: 4 }],
      missingInputs: [],
      allowedActions: ["acknowledge"],
      details: [
        { label: "protocol_number", value: "310" },
        { label: "protocol_name", value: "Shoulder MRI - Standard" },
        { label: "contrast", value: "no" },
        { label: "Tesla", value: "1.5>3" },
      ],
    },
  ],
  trace: [
    { nodeId: "anat", type: "anatomy_detection", label: "Anatomy", state: "completed", outputs: {}, unknown: [], ai: { status: "used", answer: "{כתף - מערכת השלד והשרירים}" } },
    { nodeId: "sel", type: "protocol_selection", label: "Protocol", state: "completed", outputs: {}, unknown: [], ai: { status: "invalid", answer: "x|Knee" } },
  ],
} as unknown as RunDetail;

describe("RunResult: MRI protocol selection", () => {
  it("shows the selected protocol, its explanation, row values, the anatomy and the AI answers", async () => {
    await i18n.changeLanguage("en");
    render(
      <MemoryRouter>
        <RunResult run={run} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Review selected protocol .*310.*Shoulder MRI - Standard/)).toBeInTheDocument();
    expect(screen.getByText("כאב כתף ממושך ללא ניתוח קודם.")).toBeInTheDocument();
    expect(screen.getByText("Tesla")).toBeInTheDocument();
    expect(screen.getByText("1.5>3")).toBeInTheDocument();
    expect(screen.getByText("Protocol number")).toBeInTheDocument();
    expect(screen.getByText("Anatomy:")).toBeInTheDocument();
    expect(screen.getByText("AI chose the anatomy from the protocol table.")).toBeInTheDocument();
    expect(screen.getByText(/not one of this anatomy's protocol names/)).toBeInTheDocument();
    expect(screen.getAllByText("AI answer (as returned)")).toHaveLength(2);
    // Hebrew values are isolated so they read correctly next to English labels.
    expect(screen.getByText("1.5>3").tagName).toBe("BDI");
  });
});
