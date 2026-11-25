/** Studio API client: bearer token from the CRE sign-in; errors carry the API's code and message. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type TokenProvider = () => Promise<string>;

let tokenProvider: TokenProvider = async () => "";
export function setTokenProvider(p: TokenProvider) {
  tokenProvider = p;
}

const BASE = "/api";

// Requests in flight, for the thin progress bar at the top of the page.
let inFlight = 0;
const activityListeners = new Set<(n: number) => void>();
export function onApiActivity(fn: (n: number) => void): () => void {
  activityListeners.add(fn);
  return () => activityListeners.delete(fn);
}
function setInFlight(n: number) {
  inFlight = n;
  for (const fn of activityListeners) fn(inFlight);
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; form?: FormData; headers?: Record<string, string> } = {}): Promise<T> {
  const token = await tokenProvider();
  const headers: Record<string, string> = { ...init.headers, Authorization: `Bearer ${token}` };
  let body: BodyInit | undefined;
  if (init.form) body = init.form;
  else if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  setInFlight(inFlight + 1);
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${BASE}${path}`, { method: init.method ?? (body ? "POST" : "GET"), headers, body });
    text = await res.text();
  } finally {
    setInFlight(inFlight - 1);
  }
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? "error", data?.message ?? `Request failed (${res.status})`);
  return data as T;
}

// ------------------------------------------------------------ types (API responses)

export interface StudioUser {
  id: string;
  tenantId: string;
  email: string | null;
  displayName: string | null;
  role: "admin" | "author" | "approver" | "viewer";
}

export type SourceKind = "device_protocol" | "clinical_rule" | "reference_document";
export type RevisionStatus = "draft" | "in_review" | "approved" | "withdrawn" | "expired";

export interface FieldDef {
  name: string;
  label: string;
  type: string;
  values?: string[];
}

export interface SourceSummary {
  id: string;
  kind: SourceKind;
  name: string;
  issuingOrg: string | null;
  latestRevision: { id: string; revisionNo: number; status: RevisionStatus; rowCount: number; errorCount: number } | null;
}

export interface UploadResult {
  fileId: string;
  fileType: "xlsx" | "csv";
  sha256: string;
  sheets: { name: string; rowCount: number }[];
}

export interface Preview {
  headers: string[];
  totalRows: number;
  rows: { rowNumber: number; values: unknown[]; formulaColumns: number[] }[];
}

export interface RowError {
  field: string | null;
  ref: string | null;
  message: string;
}

export interface Revision {
  id: string;
  sourceId: string;
  sourceName: string;
  kind: SourceKind;
  revisionNo: number;
  status: RevisionStatus;
  sheet: string | null;
  headerRow: number;
  mapping: Record<string, string>;
  scope: Record<string, unknown> | null;
  clinicalOwner: string;
  effectiveFrom: string | null;
  reviewDue: string;
  rowCount: number;
  errorCount: number;
  rowsSha256: string;
  createdBy: string;
  approvedBy: string | null;
  rows: { rowId: string; originalRow: number; cells: Record<string, { v: unknown; ref: string }>; mapped: Record<string, unknown>; errors: RowError[] }[];
}

// ------------------------------------------------------------ agents (week 2)

export type AgentKind = "cds" | "voice";

export interface BlockOutput {
  name: string;
  type: string;
  values?: string[];
}

export interface BlockDef {
  type: string;
  kinds: AgentKind[];
  label: string;
  ports: string[];
  outputs: BlockOutput[];
  aiCapable: boolean;
  /** Always an AI step. */
  aiRequired?: boolean;
  /** Built-in prompt, used when the prompt is left empty. */
  defaultPrompt?: string;
  knowledgeKind?: SourceKind;
  terminal?: boolean;
  start?: boolean;
}

export interface PolicyRule {
  id: string;
  text: string;
  kinds: AgentKind[];
  locked: boolean;
  binding: { type: string; category?: string; capability?: string; check?: string };
}

export interface Catalog {
  blocks: BlockDef[];
  operators: string[];
  mandatoryRules: PolicyRule[];
  optionalRules: PolicyRule[];
  outputCategories: string[];
}

export interface PromptRef {
  promptId?: string | null;
  revisionId?: string | null;
  draftText?: string | null;
}

export interface GraphNode {
  id: string;
  type: string;
  label: string;
  executionKind?: "deterministic" | "ai";
  prompt?: PromptRef | null;
  inputBindings?: Record<string, { nodeId: string; field: string }>;
  condition?: { nodeId: string; field: string; operator: string; value?: unknown } | null;
  knowledgeRevisionId?: string | null;
  clinicProfileId?: string | null;
  outputCategories?: string[];
  position?: { x: number; y: number };
}

export interface GraphEdge {
  id: string;
  from: string;
  port: string;
  to: string;
}

export interface CustomProhibition {
  id: string;
  text: string;
  owner: string;
  binding: { type: "deny_output"; category: string } | { type: "deny_capability"; capability: string } | null;
  reviewed: boolean;
}

export interface AgentDraft {
  version: number;
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  agentPrompt: PromptRef | null;
  prohibitions: { optional: string[]; custom: CustomProhibition[] };
}

export interface Agent {
  id: string;
  kind: AgentKind;
  name: string;
  intendedUse: string;
  scope: Record<string, unknown>;
  executionMode: string;
  draft: AgentDraft;
}

export interface AgentSummary {
  id: string;
  kind: AgentKind;
  name: string;
  intendedUse: string;
  draftVersion: number;
  candidates: number;
}

export interface Issue {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface CompileResult {
  ok: boolean;
  issues: Issue[];
  manifest: Record<string, unknown> | null;
  manifestHash: string | null;
  preview: string[];
  draftVersion: number;
}

export interface ClinicProfile {
  id: string;
  profileKey: string;
  revisionNo: number;
  name: string;
  site: string;
  department: string;
  subdepartment: string | null;
  risProcedureCode: string;
  protocolCode: string | null;
  questions: { id: string; text: string; answerType: string }[];
  horizonDays: number;
  status: "draft" | "approved" | "withdrawn";
  createdBy: string;
}

// ------------------------------------------------------------ runs (week 3)

export interface Candidate {
  id: string;
  candidateNo: number;
  manifestHash: string;
  draftVersion: number;
  status: string;
  createdAt: string;
}

export interface Evidence {
  knowledgeRevisionId: string;
  sourceName: string;
  rowId: string;
  sheet: string | null;
  sourceRow: number;
}

export interface Finding {
  code: string;
  category: string;
  severity: "info" | "review" | "warning" | "critical";
  title: string;
  detail: string | null;
  nodeId: string;
  observedInputs: { field: string; value: unknown; sourceRef: string | null; observedAt: string | null; attribution: string; quote?: string }[];
  evidence: Evidence[];
  missingInputs: string[];
  allowedActions: string[];
  /** Columns of the evidence row shown with the finding (e.g. protocol number, contrast, Tesla). */
  details?: { label: string; value: string }[];
}

export interface NodeTrace {
  nodeId: string;
  type: string;
  label: string;
  state: string;
  port?: string;
  outputs: Record<string, unknown>;
  unknown: string[];
  note?: string;
  evaluated?: { nodeId: string; field: string; operator: string; expected: unknown; actual: unknown };
  /** AI step outcome: used, nothing_found, no_note, not_configured, unavailable, rejected, budget, prompt_unavailable. */
  ai?: { status: string; fields?: string[]; reason?: string; answer?: string };
}

export interface RunDetail {
  runId: string;
  snapshot?: { facts: Record<string, { status: string; value?: unknown }> };
  purpose: "test" | "clinical";
  agentId: string;
  agentName: string;
  candidateNo: number;
  manifestHash: string;
  caseRef: string;
  state: string;
  outcome: string;
  snapshotHash: string;
  findings: Finding[];
  blockedFindings: { code: string; category: string; ruleIds: string[] }[];
  missingInputs: string[];
  trace: NodeTrace[];
  summary: { text: string; ai: string; model?: string | null } | null;
  aiCalls?: { nodeId: string; purpose: string; status: string; model: string | null; ms: number | null; reason?: string }[];
  reviews: { findingIndex: number; findingCode: string; action: string; reason: string | null; by: string; at: string }[];
  createdAt: string;
}

export interface RunSummary {
  runId: string;
  caseRef: string;
  state: string;
  outcome: string;
  candidateNo: number;
  createdAt: string;
}

// ------------------------------------------------------------ release (week 4)

export interface TestInputs {
  manualValues: Record<string, unknown>;
  deviceId?: string | null;
}

export interface PathStep {
  nodeId: string;
  state: string;
  port?: string;
}

export interface Expected {
  outcome: string;
  findingCodes?: string[];
  path?: PathStep[];
  blockedCategories?: string[];
}

export interface TestCase {
  id: string;
  name: string;
  inputs: TestInputs;
  expected: Expected;
  version: number;
  updatedAt: string;
}

export interface TestProblem {
  kind: "outcome" | "findings" | "step_missing" | "step_state" | "step_port" | "blocked" | "error";
  nodeId?: string;
  expected?: unknown;
  actual?: unknown;
}

export interface CaseResult {
  testCaseId: string;
  name: string;
  passed: boolean;
  problems: TestProblem[];
  actual: { outcome: string; findingCodes: string[]; path: PathStep[]; blockedCategories: string[] };
}

export interface TestRun {
  id: string;
  candidateId: string;
  passed: boolean;
  caseCount: number;
  failedCount: number;
  results: CaseResult[];
  at?: string;
}

export type VersionStatus = "candidate" | "approved" | "active" | "retired" | "withdrawn";

export interface AgentVersion {
  id: string;
  candidateNo: number;
  manifestHash: string;
  draftVersion: number;
  status: VersionStatus;
  statusReason: string | null;
  createdBy: string;
  createdAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  activatedAt: string | null;
  lastTest: { id: string; passed: boolean; caseCount: number; failedCount: number; at: string } | null;
}

export interface VersionDiff {
  against: { id: string; candidateNo: number } | null;
  added: string[];
  removed: string[];
  changed: string[];
}

export interface RunListItem {
  runId: string;
  caseRef: string;
  state: string;
  outcome: string;
  purpose: "test" | "clinical";
  createdAt: string;
  agentId: string;
  agentName: string;
  candidateNo: number;
}
