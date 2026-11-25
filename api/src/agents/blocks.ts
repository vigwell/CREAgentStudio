/**
 * One node library for both agent kinds (spec rev 7 §16 "Workflow model and
 * block contracts"; rev 9 §27 "CRE conversation graph and clinic profiles").
 * Each block has a typed output contract; inputs bind explicitly to an upstream
 * block's output field. No expressions, scripts or URLs anywhere.
 */
import { DEFAULT_ANATOMY_PROMPT, DEFAULT_SELECTION_PROMPT } from "../runtime/mriPrompts.js";

export type AgentKind = "cds" | "voice";
export type FieldType = "string" | "code" | "number" | "boolean" | "date" | "list" | "record";

export interface OutputField {
  name: string;
  type: FieldType;
  /** Values the field may hold (codes / booleans), for typed decisions. */
  values?: readonly string[];
}

export interface BlockDef {
  type: string;
  kinds: readonly AgentKind[];
  label: string;
  /** Output ports: "out" for ordinary blocks, "yes"/"no" for decisions, none for terminals. */
  ports: readonly string[];
  outputs: readonly OutputField[];
  /** May run an AI step (extraction / synthesis); counts against the call budget when enabled. */
  aiCapable: boolean;
  /** Needs an approved knowledge revision of this kind. */
  knowledgeKind?: "device_protocol" | "clinical_rule" | "reference_document";
  terminal?: boolean;
  start?: boolean;
  /** Always an AI step (no deterministic mode). */
  aiRequired?: boolean;
  /** Prompt used when the author leaves the prompt empty (frozen into the manifest). */
  defaultPrompt?: string;
}

const yesNo = ["yes", "no"] as const;

export const BLOCKS: readonly BlockDef[] = Object.freeze([
  // ---------------------------------------------------------------- shared
  { type: "start", kinds: ["cds", "voice"], label: "Start", ports: ["out"], outputs: [{ name: "caseId", type: "code" }, { name: "requestedAt", type: "date" }], aiCapable: false, start: true },
  { type: "decision", kinds: ["cds", "voice"], label: "Decision", ports: yesNo, outputs: [{ name: "result", type: "boolean" }], aiCapable: false },
  // ---------------------------------------------------------------- CDS (rev 7)
  {
    type: "patient_service",
    kinds: ["cds"],
    label: "Patient information service",
    ports: ["out"],
    outputs: [
      { name: "indicationCode", type: "code" },
      { name: "hasIndication", type: "boolean" },
      { name: "ageYears", type: "number" },
      { name: "sex", type: "code", values: ["female", "male", "unknown"] },
      { name: "egfr", type: "number" },
      { name: "contrastAllergy", type: "boolean" },
      { name: "pregnant", type: "boolean" },
      { name: "records", type: "list" },
    ],
    aiCapable: true,
  },
  {
    type: "protocol_lookup",
    kinds: ["cds"],
    label: "Local protocol lookup",
    ports: ["out"],
    outputs: [
      { name: "matched", type: "boolean" },
      { name: "matchCount", type: "number" },
      { name: "protocolCode", type: "code" },
      { name: "rows", type: "list" },
    ],
    aiCapable: false,
    knowledgeKind: "device_protocol",
  },
  {
    type: "guidance_lookup",
    kinds: ["cds"],
    label: "Clinical rule / guidance lookup",
    ports: ["out"],
    outputs: [
      { name: "matched", type: "boolean" },
      { name: "rating", type: "number" },
      { name: "result", type: "string" },
      { name: "rows", type: "list" },
    ],
    aiCapable: false,
    knowledgeKind: "clinical_rule",
  },
  // MRI protocol workflow (Medilis handoff, 22 Nov 2026): referral text → anatomy → one protocol of that anatomy.
  {
    type: "anatomy_detection",
    kinds: ["cds"],
    label: "Anatomy detection (AI, referral)",
    ports: ["out"],
    outputs: [
      { name: "found", type: "boolean" },
      { name: "anatomy", type: "string" },
      { name: "pediatric", type: "boolean" },
    ],
    aiCapable: true,
    aiRequired: true,
    knowledgeKind: "device_protocol",
    defaultPrompt: DEFAULT_ANATOMY_PROMPT,
  },
  {
    type: "protocol_selection",
    kinds: ["cds"],
    label: "Protocol selection (AI, referral)",
    ports: ["out"],
    outputs: [
      { name: "matched", type: "boolean" },
      { name: "protocolCode", type: "code" },
      { name: "protocolName", type: "string" },
      { name: "rows", type: "list" },
    ],
    aiCapable: true,
    aiRequired: true,
    knowledgeKind: "device_protocol",
    defaultPrompt: DEFAULT_SELECTION_PROMPT,
  },
  { type: "instruction", kinds: ["cds"], label: "Instruction / finding", ports: ["out"], outputs: [{ name: "finding", type: "record" }], aiCapable: false },
  { type: "final_synthesis", kinds: ["cds"], label: "Final synthesis", ports: [], outputs: [{ name: "summary", type: "record" }], aiCapable: true, terminal: true },
  // ---------------------------------------------------------------- Voice scheduling (rev 9)
  { type: "verify_authority", kinds: ["voice"], label: "Verify patient authority", ports: ["out"], outputs: [{ name: "verified", type: "boolean" }, { name: "relation", type: "code", values: ["patient", "representative"] }], aiCapable: false },
  {
    type: "resolve_order",
    kinds: ["voice"],
    label: "Resolve referral / order",
    ports: ["out"],
    outputs: [{ name: "found", type: "boolean" }, { name: "orderId", type: "code" }, { name: "procedureCode", type: "code" }, { name: "orderRevision", type: "code" }],
    aiCapable: false,
  },
  { type: "clinic_profile", kinds: ["voice"], label: "Clinic & exam profile", ports: ["out"], outputs: [{ name: "profileId", type: "code" }, { name: "procedureCode", type: "code" }, { name: "horizonDays", type: "number" }], aiCapable: false },
  { type: "ask_questions", kinds: ["voice"], label: "Screening questions", ports: ["out"], outputs: [{ name: "answers", type: "record" }, { name: "allAnswered", type: "boolean" }, { name: "contraindication", type: "boolean" }], aiCapable: true },
  { type: "patient_instructions", kinds: ["voice"], label: "Patient instructions", ports: ["out"], outputs: [{ name: "instructionId", type: "code" }, { name: "available", type: "boolean" }], aiCapable: false, knowledgeKind: "reference_document" },
  { type: "offer_slots", kinds: ["voice"], label: "Offer RIS slots", ports: ["out"], outputs: [{ name: "slotId", type: "code" }, { name: "chosen", type: "boolean" }], aiCapable: false },
  { type: "confirmation", kinds: ["voice"], label: "Read back and confirm", ports: yesNo, outputs: [{ name: "confirmed", type: "boolean" }], aiCapable: false },
  { type: "book", kinds: ["voice"], label: "Book in RIS", ports: [], outputs: [{ name: "bookingId", type: "code" }], aiCapable: false, terminal: true },
  { type: "transfer_staff", kinds: ["voice"], label: "Transfer to staff", ports: [], outputs: [], aiCapable: false, terminal: true },
  { type: "end_call", kinds: ["voice"], label: "End call", ports: [], outputs: [], aiCapable: false, terminal: true },
] satisfies BlockDef[]);

export const BLOCK_BY_TYPE: ReadonlyMap<string, BlockDef> = new Map(BLOCKS.map((b) => [b.type, b]));

/** Typed decision operators (spec §05 evaluator; the demo subset eq, neq, exists, gt, lt). */
export const OPERATORS = ["eq", "neq", "exists", "gt", "gte", "lt", "lte", "in"] as const;
export type Operator = (typeof OPERATORS)[number];
