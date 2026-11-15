/**
 * Knowledge Library service (tenant-scoped): upload → preview → source →
 * revision (mapped rows) → submit → independent approval → withdraw.
 * Every change is audited; approved revisions are immutable.
 */
import { createHash } from "node:crypto";
import sql from "mssql";
import type { Db } from "../db/pool.js";
import { withTenant } from "../db/tenant.js";
import { writeAudit } from "../services/audit.js";
import type { StudioUser } from "../services/users.js";
import { SOURCE_KINDS, type SourceKind } from "./fields.js";
import { normalizeRows, headersOf, type Mapping, type RowError } from "./normalize.js";
import {
  ImportError,
  fileTypeOf,
  listXlsxSheets,
  readCsv,
  readXlsxSheet,
  type FileType,
  type SheetData,
} from "./spreadsheet.js";

import { AppError } from "../errors.js";

export class KnowledgeError extends AppError {}

export type RevisionStatus = "draft" | "in_review" | "approved" | "withdrawn";

const AUTHORS = new Set(["admin", "author", "approver"]);
const APPROVERS = new Set(["admin", "approver"]);

function requireRole(user: StudioUser, allowed: Set<string>, what: string) {
  if (!allowed.has(user.role)) throw new KnowledgeError(403, "forbidden", `Your role (${user.role}) cannot ${what}`);
}

async function loadSheet(content: Buffer, fileType: FileType, sheet: string | null): Promise<SheetData> {
  if (fileType === "csv") return readCsv(content);
  if (!sheet) throw new KnowledgeError(400, "sheet_required", "Choose a sheet");
  return readXlsxSheet(content, sheet);
}

function wrapImport<T>(p: Promise<T>): Promise<T> {
  return p.catch((err) => {
    if (err instanceof ImportError) throw new KnowledgeError(422, err.code, err.message);
    throw err;
  });
}

export class KnowledgeService {
  constructor(private readonly db: Db) {}

  /** Store the original file (as uploaded, with its checksum) and list its sheets. */
  async uploadFile(user: StudioUser, filename: string, content: Buffer) {
    requireRole(user, AUTHORS, "import knowledge");
    const fileType = (() => {
      try {
        return fileTypeOf(filename);
      } catch (err) {
        throw new KnowledgeError(415, (err as ImportError).code, (err as Error).message);
      }
    })();
    const sheets = await wrapImport(
      fileType === "xlsx"
        ? listXlsxSheets(content)
        : Promise.resolve([{ name: "(csv)", rowCount: readCsv(content).rows.length }]),
    );
    const sha256 = createHash("sha256").update(content).digest("hex");
    const id = await withTenant(this.db, user.tenantId, async (tx) => {
      const r = await new sql.Request(tx)
        .input("tenant", sql.UniqueIdentifier, user.tenantId)
        .input("name", sql.NVarChar(260), filename.slice(0, 260))
        .input("type", sql.NVarChar(10), fileType)
        .input("size", sql.Int, content.length)
        .input("sha", sql.Char(64), sha256)
        .input("content", sql.VarBinary(sql.MAX), content)
        .input("user", sql.UniqueIdentifier, user.id)
        .query<{ id: string }>(
          `INSERT INTO studio.knowledge_files (tenant_id, original_filename, file_type, size_bytes, sha256, content, uploaded_by)
           OUTPUT inserted.id VALUES (@tenant, @name, @type, @size, @sha, @content, @user)`,
        );
      const fileId = r.recordset[0].id.toLowerCase();
      await writeAudit(tx, {
        tenantId: user.tenantId,
        userId: user.id,
        action: "knowledge.file_uploaded",
        entityType: "knowledge_file",
        entityId: fileId,
        details: { filename, fileType, sizeBytes: content.length, sha256 },
      });
      return fileId;
    });
    return { fileId: id, fileType, sha256, sheets };
  }

  private async file(user: StudioUser, fileId: string) {
    const f = await withTenant(this.db, user.tenantId, async (tx) =>
      (
        await new sql.Request(tx)
          .input("id", sql.UniqueIdentifier, fileId)
          .query<{ file_type: FileType; content: Buffer; original_filename: string }>(
            "SELECT file_type, content, original_filename FROM studio.knowledge_files WHERE id = @id",
          )
      ).recordset[0],
    );
    if (!f) throw new KnowledgeError(404, "not_found", "File not found");
    return f;
  }

  /** Headers of the chosen header row and the first rows, to choose the mapping. */
  async preview(user: StudioUser, fileId: string, sheet: string | null, headerRow: number, limit = 20) {
    const f = await this.file(user, fileId);
    const data = await wrapImport(loadSheet(f.content, f.file_type, sheet));
    const headers = await wrapImport(Promise.resolve().then(() => headersOf(data, headerRow)));
    const rows = data.rows.filter((r) => r.rowNumber > headerRow);
    return {
      headers,
      totalRows: rows.length,
      rows: rows.slice(0, limit).map((r) => ({ rowNumber: r.rowNumber, values: r.values, formulaColumns: r.formulaColumns })),
    };
  }

  async createSource(user: StudioUser, input: { kind: string; name: string; issuingOrg?: string | null }) {
    requireRole(user, AUTHORS, "create knowledge sources");
    if (!SOURCE_KINDS.includes(input.kind as SourceKind)) {
      throw new KnowledgeError(400, "bad_kind", `kind must be one of ${SOURCE_KINDS.join(", ")}`);
    }
    const name = String(input.name ?? "").trim();
    if (!name) throw new KnowledgeError(400, "name_required", "Name is required");
    return withTenant(this.db, user.tenantId, async (tx) => {
      const dup = await new sql.Request(tx)
        .input("name", sql.NVarChar(200), name)
        .query("SELECT 1 AS x FROM studio.knowledge_sources WHERE name = @name");
      if (dup.recordset.length) throw new KnowledgeError(409, "duplicate", `A source named "${name}" exists`);
      const r = await new sql.Request(tx)
        .input("tenant", sql.UniqueIdentifier, user.tenantId)
        .input("kind", sql.NVarChar(30), input.kind)
        .input("name", sql.NVarChar(200), name)
        .input("org", sql.NVarChar(200), input.issuingOrg?.trim() || null)
        .input("user", sql.UniqueIdentifier, user.id)
        .query<{ id: string }>(
          `INSERT INTO studio.knowledge_sources (tenant_id, kind, name, issuing_org, created_by)
           OUTPUT inserted.id VALUES (@tenant, @kind, @name, @org, @user)`,
        );
      const id = r.recordset[0].id.toLowerCase();
      await writeAudit(tx, {
        tenantId: user.tenantId,
        userId: user.id,
        action: "knowledge.source_created",
        entityType: "knowledge_source",
        entityId: id,
        details: { kind: input.kind, name },
      });
      return { id, kind: input.kind as SourceKind, name };
    });
  }

  async listSources(user: StudioUser) {
    return withTenant(this.db, user.tenantId, async (tx) => {
      const r = await new sql.Request(tx).query(
        `SELECT s.id, s.kind, s.name, s.issuing_org, s.created_at,
                r.id AS revision_id, r.revision_no, r.status, r.review_due, r.row_count, r.error_count
         FROM studio.knowledge_sources s
         OUTER APPLY (SELECT TOP 1 * FROM studio.knowledge_revisions x WHERE x.source_id = s.id ORDER BY x.revision_no DESC) r
         ORDER BY s.name`,
      );
      return r.recordset.map((x: Record<string, unknown>) => ({
        id: String(x.id).toLowerCase(),
        kind: x.kind,
        name: x.name,
        issuingOrg: x.issuing_org,
        latestRevision: x.revision_id
          ? {
              id: String(x.revision_id).toLowerCase(),
              revisionNo: x.revision_no,
              status: effectiveStatus(x.status as RevisionStatus, x.review_due as Date),
              rowCount: x.row_count,
              errorCount: x.error_count,
            }
          : null,
      }));
    });
  }

  /**
   * A new draft revision from an uploaded file: the chosen sheet, header row and
   * column mapping. Any change to data, mapping, units or scope is a new revision.
   */
  async createRevision(
    user: StudioUser,
    sourceId: string,
    input: {
      fileId: string;
      sheet: string | null;
      headerRow: number;
      mapping: Mapping;
      scope?: Record<string, unknown> | null;
      clinicalOwner: string;
      effectiveFrom?: string | null;
      reviewDue: string;
    },
  ) {
    requireRole(user, AUTHORS, "create revisions");
    if (!String(input.clinicalOwner ?? "").trim()) throw new KnowledgeError(400, "owner_required", "A clinical owner is required");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.reviewDue ?? ""))) {
      throw new KnowledgeError(400, "review_due_required", "A review date (YYYY-MM-DD) is required");
    }
    if (input.effectiveFrom && !/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom)) {
      throw new KnowledgeError(400, "bad_date", "effectiveFrom must be YYYY-MM-DD");
    }
    const source = await withTenant(this.db, user.tenantId, async (tx) =>
      (
        await new sql.Request(tx)
          .input("id", sql.UniqueIdentifier, sourceId)
          .query<{ kind: SourceKind }>("SELECT kind FROM studio.knowledge_sources WHERE id = @id")
      ).recordset[0],
    );
    if (!source) throw new KnowledgeError(404, "not_found", "Source not found");
    const f = await this.file(user, input.fileId);
    const data = await wrapImport(loadSheet(f.content, f.file_type, input.sheet));
    const normalized = await wrapImport(
      Promise.resolve().then(() => normalizeRows(data, { headerRow: input.headerRow, mapping: input.mapping, kind: source.kind })),
    );

    return withTenant(this.db, user.tenantId, async (tx) => {
      const next = await new sql.Request(tx)
        .input("source", sql.UniqueIdentifier, sourceId)
        .query<{ n: number }>("SELECT ISNULL(MAX(revision_no), 0) + 1 AS n FROM studio.knowledge_revisions WITH (UPDLOCK, HOLDLOCK) WHERE source_id = @source");
      const revisionNo = next.recordset[0].n;
      const r = await new sql.Request(tx)
        .input("tenant", sql.UniqueIdentifier, user.tenantId)
        .input("source", sql.UniqueIdentifier, sourceId)
        .input("no", sql.Int, revisionNo)
        .input("file", sql.UniqueIdentifier, input.fileId)
        .input("sheet", sql.NVarChar(100), data.name)
        .input("header", sql.Int, input.headerRow)
        .input("mapping", sql.NVarChar(sql.MAX), JSON.stringify(input.mapping))
        .input("scope", sql.NVarChar(sql.MAX), input.scope ? JSON.stringify(input.scope) : null)
        .input("owner", sql.NVarChar(200), input.clinicalOwner.trim())
        .input("from", sql.Date, input.effectiveFrom || null)
        .input("due", sql.Date, input.reviewDue)
        .input("rows", sql.Int, normalized.rows.length)
        .input("errors", sql.Int, normalized.errorCount)
        .input("sha", sql.Char(64), normalized.rowsSha256)
        .input("user", sql.UniqueIdentifier, user.id)
        .query<{ id: string }>(
          `INSERT INTO studio.knowledge_revisions
             (tenant_id, source_id, revision_no, file_id, sheet_name, header_row, mapping, scope, clinical_owner,
              effective_from, review_due, row_count, error_count, rows_sha256, created_by)
           OUTPUT inserted.id
           VALUES (@tenant, @source, @no, @file, @sheet, @header, @mapping, @scope, @owner, @from, @due, @rows, @errors, @sha, @user)`,
        );
      const revisionId = r.recordset[0].id.toLowerCase();

      if (normalized.rows.length) {
        const table = new sql.Table("studio.knowledge_rows");
        table.create = false;
        table.columns.add("tenant_id", sql.UniqueIdentifier, { nullable: false });
        table.columns.add("revision_id", sql.UniqueIdentifier, { nullable: false });
        table.columns.add("row_id", sql.NVarChar(100), { nullable: false });
        table.columns.add("original_row", sql.Int, { nullable: false });
        table.columns.add("cells", sql.NVarChar(sql.MAX), { nullable: false });
        table.columns.add("mapped", sql.NVarChar(sql.MAX), { nullable: false });
        table.columns.add("errors", sql.NVarChar(sql.MAX), { nullable: true });
        for (const row of normalized.rows) {
          table.rows.add(
            user.tenantId,
            revisionId,
            row.rowId.slice(0, 100),
            row.originalRow,
            JSON.stringify(row.cells),
            JSON.stringify(row.mapped),
            row.errors.length ? JSON.stringify(row.errors) : null,
          );
        }
        await new sql.Request(tx).bulk(table);
      }
      await writeAudit(tx, {
        tenantId: user.tenantId,
        userId: user.id,
        action: "knowledge.revision_created",
        entityType: "knowledge_revision",
        entityId: revisionId,
        details: { sourceId, revisionNo, rows: normalized.rows.length, errorRows: normalized.errorCount, rowsSha256: normalized.rowsSha256 },
      });
      return {
        id: revisionId,
        revisionNo,
        status: "draft" as RevisionStatus,
        rowCount: normalized.rows.length,
        errorCount: normalized.errorCount,
        headers: normalized.headers,
        errors: normalized.rows
          .filter((x) => x.errors.length)
          .slice(0, 200)
          .map((x) => ({ row: x.originalRow, errors: x.errors })),
      };
    });
  }

  async getRevision(user: StudioUser, revisionId: string, page = 0, pageSize = 100) {
    return withTenant(this.db, user.tenantId, async (tx) => {
      const rev = (
        await new sql.Request(tx).input("id", sql.UniqueIdentifier, revisionId).query(
          `SELECT r.*, s.name AS source_name, s.kind
           FROM studio.knowledge_revisions r JOIN studio.knowledge_sources s ON s.id = r.source_id
           WHERE r.id = @id`,
        )
      ).recordset[0] as Record<string, unknown> | undefined;
      if (!rev) throw new KnowledgeError(404, "not_found", "Revision not found");
      const rows = (
        await new sql.Request(tx)
          .input("id", sql.UniqueIdentifier, revisionId)
          .input("skip", sql.Int, Math.max(0, page) * pageSize)
          .input("take", sql.Int, Math.min(500, Math.max(1, pageSize)))
          .query(
            `SELECT row_id, original_row, cells, mapped, errors FROM studio.knowledge_rows
             WHERE revision_id = @id ORDER BY original_row OFFSET @skip ROWS FETCH NEXT @take ROWS ONLY`,
          )
      ).recordset as { row_id: string; original_row: number; cells: string; mapped: string; errors: string | null }[];
      const id = (x: unknown) => (x ? String(x).toLowerCase() : null);
      return {
        id: id(rev.id),
        sourceId: id(rev.source_id),
        sourceName: rev.source_name,
        kind: rev.kind,
        revisionNo: rev.revision_no,
        status: effectiveStatus(rev.status as RevisionStatus, rev.review_due as Date),
        sheet: rev.sheet_name,
        headerRow: rev.header_row,
        mapping: JSON.parse(String(rev.mapping)),
        scope: rev.scope ? JSON.parse(String(rev.scope)) : null,
        clinicalOwner: rev.clinical_owner,
        effectiveFrom: dateOnly(rev.effective_from),
        reviewDue: dateOnly(rev.review_due),
        rowCount: rev.row_count,
        errorCount: rev.error_count,
        rowsSha256: rev.rows_sha256,
        createdBy: id(rev.created_by),
        approvedBy: id(rev.approved_by),
        approvedAt: rev.approved_at,
        rows: rows.map((x) => ({
          rowId: x.row_id,
          originalRow: x.original_row,
          cells: JSON.parse(x.cells),
          mapped: JSON.parse(x.mapped),
          errors: x.errors ? (JSON.parse(x.errors) as RowError[]) : [],
        })),
      };
    });
  }

  /** Author hands a structurally valid draft to review. */
  async submit(user: StudioUser, revisionId: string) {
    requireRole(user, AUTHORS, "submit revisions");
    return this.transition(user, revisionId, "knowledge.revision_submitted", async (tx, rev) => {
      if (rev.status !== "draft") throw new KnowledgeError(409, "bad_state", `Only a draft can be submitted (now ${rev.status})`);
      if (rev.error_count > 0) {
        throw new KnowledgeError(422, "has_errors", `${rev.error_count} row(s) have errors; fix the source and import a new revision`);
      }
      await new sql.Request(tx)
        .input("id", sql.UniqueIdentifier, revisionId)
        .input("user", sql.UniqueIdentifier, user.id)
        .query("UPDATE studio.knowledge_revisions SET status = N'in_review', submitted_by = @user, submitted_at = SYSUTCDATETIME() WHERE id = @id");
      return "in_review";
    });
  }

  /** Independent clinical approval: an approver who did not author the revision. */
  async approve(user: StudioUser, revisionId: string) {
    requireRole(user, APPROVERS, "approve revisions");
    return this.transition(user, revisionId, "knowledge.revision_approved", async (tx, rev) => {
      if (rev.status !== "in_review") throw new KnowledgeError(409, "bad_state", `Only a revision in review can be approved (now ${rev.status})`);
      if (String(rev.created_by).toLowerCase() === user.id) {
        throw new KnowledgeError(403, "not_independent", "The author of a revision cannot approve it");
      }
      if (dateOnly(rev.review_due)! < todayUtc()) throw new KnowledgeError(409, "expired", "The review date has passed; import a new revision");
      await new sql.Request(tx)
        .input("id", sql.UniqueIdentifier, revisionId)
        .input("user", sql.UniqueIdentifier, user.id)
        .query("UPDATE studio.knowledge_revisions SET status = N'approved', approved_by = @user, approved_at = SYSUTCDATETIME() WHERE id = @id");
      return "approved";
    });
  }

  /** Back to the author (review found a problem). */
  async returnToDraft(user: StudioUser, revisionId: string, reason: string) {
    requireRole(user, APPROVERS, "return revisions");
    return this.transition(user, revisionId, "knowledge.revision_returned", async (tx, rev) => {
      if (rev.status !== "in_review") throw new KnowledgeError(409, "bad_state", `Only a revision in review can be returned (now ${rev.status})`);
      await new sql.Request(tx)
        .input("id", sql.UniqueIdentifier, revisionId)
        .query("UPDATE studio.knowledge_revisions SET status = N'draft', submitted_by = NULL, submitted_at = NULL WHERE id = @id");
      return "draft";
    }, { reason });
  }

  /** Withdrawn sources block dependent new runs (spec section 04). */
  async withdraw(user: StudioUser, revisionId: string, reason: string) {
    requireRole(user, APPROVERS, "withdraw revisions");
    if (!String(reason ?? "").trim()) throw new KnowledgeError(400, "reason_required", "A reason is required");
    return this.transition(user, revisionId, "knowledge.revision_withdrawn", async (tx, rev) => {
      if (rev.status === "withdrawn") throw new KnowledgeError(409, "bad_state", "Already withdrawn");
      await new sql.Request(tx)
        .input("id", sql.UniqueIdentifier, revisionId)
        .input("user", sql.UniqueIdentifier, user.id)
        .query("UPDATE studio.knowledge_revisions SET status = N'withdrawn', withdrawn_by = @user, withdrawn_at = SYSUTCDATETIME() WHERE id = @id");
      return "withdrawn";
    }, { reason });
  }

  private async transition(
    user: StudioUser,
    revisionId: string,
    action: string,
    apply: (tx: sql.Transaction, rev: { status: RevisionStatus; error_count: number; created_by: string; review_due: Date }) => Promise<RevisionStatus>,
    details: Record<string, unknown> = {},
  ) {
    return withTenant(this.db, user.tenantId, async (tx) => {
      const rev = (
        await new sql.Request(tx)
          .input("id", sql.UniqueIdentifier, revisionId)
          .query("SELECT status, error_count, created_by, review_due FROM studio.knowledge_revisions WITH (UPDLOCK) WHERE id = @id")
      ).recordset[0];
      if (!rev) throw new KnowledgeError(404, "not_found", "Revision not found");
      const status = await apply(tx, rev);
      await writeAudit(tx, {
        tenantId: user.tenantId,
        userId: user.id,
        action,
        entityType: "knowledge_revision",
        entityId: revisionId,
        details: { from: rev.status, to: status, ...details },
      });
      return { id: revisionId, status };
    });
  }
}

function dateOnly(v: unknown): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** "expired" is derived: an approved revision past its review date blocks new runs. */
export function effectiveStatus(status: RevisionStatus, reviewDue: Date | string | null): RevisionStatus | "expired" {
  if (status === "approved" && reviewDue && dateOnly(reviewDue)! < todayUtc()) return "expired";
  return status;
}
