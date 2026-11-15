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

export async function api<T>(path: string, init: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const token = await tokenProvider();
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  let body: BodyInit | undefined;
  if (init.form) body = init.form;
  else if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const res = await fetch(`${BASE}${path}`, { method: init.method ?? (body ? "POST" : "GET"), headers, body });
  const text = await res.text();
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
