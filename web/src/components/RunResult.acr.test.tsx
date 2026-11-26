import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import i18n from "../i18n";
import { RunResult } from "./RunResult";
import type { RunDetail } from "../api/client";

const topicInputs = [
  { field: "topic", value: "Headache", sourceRef: "clinicalNote", observedAt: null, attribution: "ai" },
  { field: "modality", value: "ct", sourceRef: "clinicalNote", observedAt: null, attribution: "ai" },
];

const run = {
  runId: "r1",
  agentId: "a1",
  caseRef: "ACR-1",
  candidateNo: 1,
  createdAt: "2026-11-26T10:00:00Z",
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
      code: "ACR_RULE_PRIMARY",
      category: "appropriateness_finding",
      severity: "review",
      title: "Review ACR rule CT_HEAD_001: No imaging",
      detail: "מיגרנה יציבה ללא red flags.",
      nodeId: "rules",
      observedInputs: topicInputs,
      evidence: [{ knowledgeRevisionId: "rev", sourceName: "ACR rules", rowId: "CT_HEAD_001", sheet: "ACR rules", sourceRow: 2 }],
      missingInputs: [],
      allowedActions: ["acknowledge"],
      details: [
        { label: "Rule ID", value: "CT_HEAD_001" },
        { label: "החלטת מערכת", value: "Suggest no imaging" },
      ],
    },
    {
      code: "ACR_RULE_RELATED",
      category: "appropriateness_finding",
      severity: "info",
      title: "Related ACR rule CT_HEAD_003 (rank 2)",
      detail: "לשלול חסר נוירולוגי.",
      nodeId: "rules",
      observedInputs: topicInputs,
      evidence: [],
      missingInputs: [],
      allowedActions: ["acknowledge"],
    },
  ],
  trace: [
    { nodeId: "topic", type: "acr_topic_detection", label: "ACR topic", state: "completed", outputs: {}, unknown: [], ai: { status: "used", answer: "{Headache}|{ct}" } },
    { nodeId: "rules", type: "acr_rule_selection", label: "ACR rules", state: "completed", outputs: {}, unknown: [], ai: { status: "used", answer: "CT_HEAD_001|1|…", count: 3, topic: "Headache", modality: "ct" } },
  ],
} as unknown as RunDetail;

describe("RunResult: ACR decision support", () => {
  it("shows the primary and related rules, their explanations and row values, and which rules were evaluated", async () => {
    await i18n.changeLanguage("en");
    render(
      <MemoryRouter>
        <RunResult run={run} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Review ACR rule .*CT_HEAD_001.*: .*No imaging/)).toBeInTheDocument();
    expect(screen.getByText(/Related ACR rule .*CT_HEAD_003.* \(rank 2\)/)).toBeInTheDocument();
    expect(screen.getByText("מיגרנה יציבה ללא red flags.")).toBeInTheDocument();
    expect(screen.getByText("Suggest no imaging")).toBeInTheDocument();
    expect(screen.getByText("AI chose the ACR topic and the requested modality from the catalogue's topic list.")).toBeInTheDocument();
    expect(screen.getByText(/AI ranked the 3 rules of the topic .*Headache.* \(CT catalogue\)\. Rules under other topics were not evaluated\./)).toBeInTheDocument();
    expect(screen.getAllByText("AI answer (as returned)")).toHaveLength(2);
  });

  it("Hebrew: the finding titles in Hebrew, rule ids isolated", async () => {
    await i18n.changeLanguage("he");
    render(
      <MemoryRouter>
        <RunResult run={run} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/לבדיקה: כלל ה-ACR שנבחר .*CT_HEAD_001/)).toBeInTheDocument();
    expect(screen.getByText(/כלל ACR קשור .*CT_HEAD_003.* \(דירוג 2\)/)).toBeInTheDocument();
    await i18n.changeLanguage("en");
  });
});
