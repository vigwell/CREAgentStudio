/**
 * CDS runs: capture an immutable input snapshot, execute a frozen candidate,
 * persist the result, and record clinician reviews (spec rev 7 §07, §10).
 *
 * Week 3 runs are test runs against a chosen candidate (activation of an
 * approved version per scope comes with the release flow). Patient values are
 * entered manually and attributed to the user; the CRE patient information
 * service plugs in behind the same snapshot.
 */
import { createHash } from "node:crypto";
import sql from "mssql";
import type { Db } from "../db/pool.js";
import { withTenant } from "../db/tenant.js";
import { AppError } from "../errors.js";
import { writeAudit } from "../services/audit.js";
import type { StudioUser } from "../services/users.js";
import { effectiveStatus } from "../knowledge/service.js";
import { canonicalJson } from "../agents/compiler.js";
import { snapshotHash, type Fact, type InputSnapshot, type KnowledgeBinding, type Manifest, type RunResult } from "./engine.js";
import type { AiClient } from "./aiClient.js";
import { NOTE_FIELD, NOTE_MAX_CHARS, runAgent } from "./aiSteps.js";

const lower = (x: unknown) => (x ? String(x).toLowerCase() : null);
const REVIEW_ACTIONS = new Set(["acknowledge", "dismiss", "defer"]);
const MANUAL_FIELDS: Record<string, "code" | "boolean" | "number" | "text"> = {
  indicationCode: "code",
  hasIndication: "boolean",
  ageYears: "number",
  sex: "code",
  egfr: "number",
  contrastAllergy: "boolean",
  pregnant: "boolean",
  /** Free-text clinical note; read only by an AI extraction step. */
  [NOTE_FIELD]: "text",
};

export interface RunRequest {
  agentId: string;
  /** A specific candidate (test run); omitted = the agent's active version (clinical run). */
  candidateId?: string | null;
  caseRef: string;
  deviceId?: string | null;
  executionMode?: string;
  reportContext?: unknown;
  inputs?: { manualValues?: Record<string, unknown> };
}

/** Manual values become attributed facts; anything not entered is "missing", never false. */
export function factsFromManual(values: Record<string, unknown>, userId: string, at: string): Record<string, Fact> {
  const facts: Record<string, Fact> = {};
  for (const [field, type] of Object.entries(MANUAL_FIELDS)) {
    const raw = values[field];
    if (raw === undefined || raw === null || raw === "") {
      facts[field] = { status: "missing" };
      continue;
    }
    let value: unknown = raw;
    if (type === "number") value = typeof raw === "number" ? raw : Number(raw);
    if (type === "boolean") value = raw === true || raw === "true" ? true : raw === false || raw === "false" ? false : undefined;
    if (type === "text") {
      if (typeof raw !== "string") throw new AppError(422, "bad_input", `${field}: expected text`);
      if (raw.length > NOTE_MAX_CHARS) throw new AppError(422, "bad_input", `${field}: at most ${NOTE_MAX_CHARS} characters`);
      if (!raw.trim()) {
        facts[field] = { status: "missing" };
        continue;
      }
    }
    if ((type === "number" && !Number.isFinite(value as number)) || value === undefined) {
      throw new AppError(422, "bad_input", `${field}: expected a ${type}`);
    }
    facts[field] = { value: type === "code" || type === "text" ? String(value).trim() : value, status: "present", sourceRef: "manual", observedAt: at, attribution: { kind: "manual", userId } };
  }
  for (const k of Object.keys(values)) if (!(k in MANUAL_FIELDS)) throw new AppError(422, "bad_input", `${k} is not an approved input field`);
  return facts;
}

/** The knowledge revisions a candidate binds, with their status now and their rows. */
export async function loadKnowledge(tx: sql.Transaction, revisionIds: string[]): Promise<Map<string, KnowledgeBinding>> {
  const knowledge = new Map<string, KnowledgeBinding>();
  for (const revId of revisionIds) {
    const rev = (
      await new sql.Request(tx)
        .input("id", sql.UniqueIdentifier, revId)
        .query("SELECT r.id, r.status, r.review_due, r.sheet_name, s.name, s.kind FROM studio.knowledge_revisions r JOIN studio.knowledge_sources s ON s.id = r.source_id WHERE r.id = @id")
    ).recordset[0];
    if (!rev) continue;
    const rows = await new sql.Request(tx)
      .input("id", sql.UniqueIdentifier, revId)
      .query("SELECT row_id, original_row, mapped, errors FROM studio.knowledge_rows WHERE revision_id = @id ORDER BY original_row");
    knowledge.set(revId, {
      revisionId: revId,
      sourceName: String(rev.name),
      kind: String(rev.kind),
      status: effectiveStatus(rev.status, rev.review_due),
      rows: rows.recordset.map((x: Record<string, unknown>) => ({
        rowId: String(x.row_id),
        sheet: (rev.sheet_name as string) ?? null,
        originalRow: Number(x.original_row),
        mapped: JSON.parse(String(x.mapped ?? "{}")),
        hasErrors: JSON.parse(String(x.errors ?? "[]")).length > 0,
      })),
    });
  }
  return knowledge;
}

export class RunService {
  constructor(
    private readonly db: Db,
    private readonly ai: AiClient | null = null,
  ) {}

  /**
   * Phase 1 (transaction): idempotency check, candidate, knowledge.
   * Phase 2 (no transaction): run, including any AI calls, so a slow AI
   * service never holds database locks.
   * Phase 3 (transaction): store snapshot, run and audit. A concurrent request
   * with the same key that finished first wins; this one replays it.
   */
  async start(user: StudioUser, idempotencyKey: string | undefined, body: RunRequest) {
    if (!idempotencyKey || idempotencyKey.length > 100) throw new AppError(428, "idempotency_key_required", "Send an Idempotency-Key header (up to 100 characters)");
    const caseRef = String(body.caseRef ?? "").trim();
    if (!caseRef) throw new AppError(422, "case_required", "caseRef is required");
    const mode = body.executionMode ?? "standalone_cds";
    if (mode === "standalone_cds" && body.reportContext !== undefined) throw new AppError(422, "report_context_not_allowed", "reportContext is not allowed in standalone mode");
    const requestHash = `sha256:${createHash("sha256").update(canonicalJson(body)).digest("hex")}`;
    const findPrior = async (tx: sql.Transaction) =>
      (
        await new sql.Request(tx)
          .input("user", sql.UniqueIdentifier, user.id)
          .input("key", sql.NVarChar(100), idempotencyKey)
          .query("SELECT id, request_hash FROM studio.agent_runs WHERE created_by = @user AND idempotency_key = @key")
      ).recordset[0];
    const replay = (prior: { id: string; request_hash: string }) => {
      if (prior.request_hash !== requestHash) throw new AppError(409, "idempotency_conflict", "This Idempotency-Key was used for a different request");
      return { runId: lower(prior.id)!, replayed: true };
    };

    const prep = await withTenant(this.db, user.tenantId, async (tx) => {
      const prior = await findPrior(tx);
      if (prior) return { replayed: replay(prior) } as const;

      const purpose = body.candidateId ? "test" : "clinical";
      const cand = (
        await new sql.Request(tx)
          .input("id", sql.UniqueIdentifier, body.candidateId ?? null)
          .input("agent", sql.UniqueIdentifier, body.agentId)
          .query(
            body.candidateId
              ? `SELECT c.id, c.manifest, c.manifest_hash, c.status, a.kind FROM studio.agent_candidates c
                 JOIN studio.agents a ON a.id = c.agent_id WHERE c.id = @id AND c.agent_id = @agent`
              : `SELECT c.id, c.manifest, c.manifest_hash, c.status, a.kind FROM studio.agent_candidates c
                 JOIN studio.agents a ON a.id = c.agent_id WHERE c.agent_id = @agent AND c.status = N'active'`,
          )
      ).recordset[0];
      if (!cand && !body.candidateId) throw new AppError(409, "no_active_version", "This agent has no active version; approve and activate a candidate first");
      if (!cand) throw new AppError(404, "not_found", "Candidate not found");
      if (cand.kind !== "cds") throw new AppError(422, "not_cds", "Only CDS agents run here; voice agents run on calls");
      if (cand.status === "withdrawn") throw new AppError(409, "candidate_withdrawn", "This candidate was withdrawn");
      const manifest = JSON.parse(String(cand.manifest)) as Manifest & { sourceBindings: string[] };
      if (manifest.executionMode !== mode) throw new AppError(422, "mode_mismatch", `This agent runs as ${manifest.executionMode}`);

      // Knowledge exactly as bound by the candidate, with its status now.
      const knowledge = await loadKnowledge(tx, manifest.sourceBindings ?? []);
      return { cand: { id: String(cand.id), manifestHash: String(cand.manifest_hash) }, manifest, knowledge, purpose } as const;
    });
    if ("replayed" in prep) return prep.replayed!;
    const { cand, manifest, knowledge, purpose } = prep;

    const now = new Date().toISOString();
    const snapshot: InputSnapshot = {
      caseRef,
      requestedAt: now,
      deviceId: body.deviceId ?? null,
      facts: factsFromManual(body.inputs?.manualValues ?? {}, user.id, now),
    };
    const snapHash = snapshotHash(snapshot);

    let result: RunResult;
    const started = Date.now();
    try {
      result = await runAgent(manifest, snapshot, knowledge, this.ai);
    } catch {
      // An engine fault fails the run; it never produces a partial clinical result.
      result = { state: "failed", outcome: "unavailable", findings: [], blockedFindings: [], missingInputs: [], trace: [], summary: null };
    }
    result.durationMs = Date.now() - started;

    try {
      return await withTenant(this.db, user.tenantId, async (tx) => {
        const prior = await findPrior(tx);
        if (prior) return replay(prior);
        const snapId = (
          await new sql.Request(tx)
            .input("tenant", sql.UniqueIdentifier, user.tenantId)
            .input("case", sql.NVarChar(200), caseRef)
            .input("content", sql.NVarChar(sql.MAX), JSON.stringify(snapshot))
            .input("hash", sql.NVarChar(80), snapHash)
            .input("user", sql.UniqueIdentifier, user.id)
            .query<{ id: string }>(
              "INSERT INTO studio.input_snapshots (tenant_id, case_ref, content, content_hash, created_by) OUTPUT inserted.id VALUES (@tenant, @case, @content, @hash, @user)",
            )
        ).recordset[0].id;

        const runId = (
          await new sql.Request(tx)
            .input("tenant", sql.UniqueIdentifier, user.tenantId)
            .input("agent", sql.UniqueIdentifier, body.agentId)
            .input("cand", sql.UniqueIdentifier, cand.id)
            .input("snap", sql.UniqueIdentifier, snapId)
            .input("key", sql.NVarChar(100), idempotencyKey)
            .input("rhash", sql.NVarChar(80), requestHash)
            .input("case", sql.NVarChar(200), caseRef)
            .input("mode", sql.NVarChar(40), mode)
            .input("purpose", sql.NVarChar(20), purpose)
            .input("state", sql.NVarChar(20), result.state)
            .input("outcome", sql.NVarChar(20), result.outcome)
            .input("result", sql.NVarChar(sql.MAX), JSON.stringify(result))
            .input("user", sql.UniqueIdentifier, user.id)
            .query<{ id: string }>(
              `INSERT INTO studio.agent_runs (tenant_id, agent_id, candidate_id, snapshot_id, idempotency_key, request_hash, case_ref, execution_mode, purpose, state, outcome, result, created_by, finished_at)
               OUTPUT inserted.id VALUES (@tenant, @agent, @cand, @snap, @key, @rhash, @case, @mode, @purpose, @state, @outcome, @result, @user, SYSUTCDATETIME())`,
            )
        ).recordset[0].id.toLowerCase();
        // Audit lists identifiers and statuses, not clinical narrative.
        await writeAudit(tx, {
          tenantId: user.tenantId,
          userId: user.id,
          action: "run.completed",
          entityType: "agent_run",
          entityId: runId,
          details: {
            agentId: body.agentId,
            candidateId: lower(cand.id),
            purpose,
            manifestHash: cand.manifestHash,
            snapshotHash: snapHash,
            state: result.state,
            outcome: result.outcome,
            ...(result.aiCalls ? { ai: result.aiCalls.map((c) => ({ purpose: c.purpose, status: c.status, model: c.model })) } : {}),
          },
        });
        return { runId, replayed: false };
      });
    } catch (err) {
      // Same key stored by a concurrent request in the meantime (unique index).
      const num = (err as { number?: number; originalError?: { info?: { number?: number } } }).number ?? (err as { originalError?: { info?: { number?: number } } }).originalError?.info?.number;
      if (num === 2601 || num === 2627) {
        const prior = await withTenant(this.db, user.tenantId, findPrior);
        if (prior) return replay(prior);
      }
      throw err;
    }
  }

  async get(user: StudioUser, runId: string) {
    return withTenant(this.db, user.tenantId, async (tx) => {
      const r = (
        await new sql.Request(tx).input("id", sql.UniqueIdentifier, runId).query(
          `SELECT r.*, c.candidate_no, c.manifest_hash, s.content AS snapshot, s.content_hash, a.name AS agent_name
           FROM studio.agent_runs r JOIN studio.agent_candidates c ON c.id = r.candidate_id
           JOIN studio.input_snapshots s ON s.id = r.snapshot_id JOIN studio.agents a ON a.id = r.agent_id WHERE r.id = @id`,
        )
      ).recordset[0];
      if (!r) throw new AppError(404, "not_found", "Run not found");
      const reviews = await new sql.Request(tx)
        .input("id", sql.UniqueIdentifier, runId)
        .query("SELECT finding_index, finding_code, action, reason, created_by, created_at FROM studio.run_reviews WHERE run_id = @id ORDER BY created_at");
      return {
        runId: lower(r.id),
        agentId: lower(r.agent_id),
        agentName: r.agent_name,
        candidateId: lower(r.candidate_id),
        candidateNo: r.candidate_no,
        manifestHash: r.manifest_hash,
        caseRef: r.case_ref,
        executionMode: r.execution_mode,
        purpose: r.purpose,
        snapshotHash: r.content_hash,
        snapshot: JSON.parse(String(r.snapshot)),
        ...(JSON.parse(String(r.result ?? "{}")) as RunResult),
        createdAt: r.created_at,
        reviews: reviews.recordset.map((x: Record<string, unknown>) => ({
          findingIndex: x.finding_index,
          findingCode: x.finding_code,
          action: x.action,
          reason: x.reason,
          by: lower(x.created_by),
          at: x.created_at,
        })),
      };
    });
  }

  async list(user: StudioUser, agentId: string) {
    return withTenant(this.db, user.tenantId, async (tx) => {
      const r = await new sql.Request(tx)
        .input("agent", sql.UniqueIdentifier, agentId)
        .query(
          `SELECT TOP 50 r.id, r.case_ref, r.state, r.outcome, r.created_at, c.candidate_no FROM studio.agent_runs r
           JOIN studio.agent_candidates c ON c.id = r.candidate_id WHERE r.agent_id = @agent ORDER BY r.created_at DESC`,
        );
      return r.recordset.map((x: Record<string, unknown>) => ({
        runId: lower(x.id),
        caseRef: x.case_ref,
        state: x.state,
        outcome: x.outcome,
        candidateNo: x.candidate_no,
        createdAt: x.created_at,
      }));
    });
  }

  /** Run Inspector: recent runs across agents, filtered. Identifiers and statuses only. */
  async search(user: StudioUser, f: { agentId?: string; outcome?: string; purpose?: string; caseRef?: string; limit?: number }) {
    return withTenant(this.db, user.tenantId, async (tx) => {
      const q = new sql.Request(tx);
      const where: string[] = [];
      if (f.agentId) {
        q.input("agent", sql.UniqueIdentifier, f.agentId);
        where.push("r.agent_id = @agent");
      }
      if (f.outcome) {
        q.input("outcome", sql.NVarChar(20), f.outcome);
        where.push("r.outcome = @outcome");
      }
      if (f.purpose) {
        q.input("purpose", sql.NVarChar(20), f.purpose);
        where.push("r.purpose = @purpose");
      }
      if (f.caseRef) {
        q.input("case", sql.NVarChar(200), `%${f.caseRef.replace(/[%_[]/g, "[$&]")}%`);
        where.push("r.case_ref LIKE @case");
      }
      q.input("limit", sql.Int, Math.min(Math.max(f.limit ?? 50, 1), 200));
      const r = await q.query(
        `SELECT TOP (@limit) r.id, r.case_ref, r.state, r.outcome, r.purpose, r.created_at, r.agent_id, a.name AS agent_name, c.candidate_no
         FROM studio.agent_runs r JOIN studio.agents a ON a.id = r.agent_id JOIN studio.agent_candidates c ON c.id = r.candidate_id
         ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY r.created_at DESC`,
      );
      return r.recordset.map((x: Record<string, unknown>) => ({
        runId: lower(x.id),
        caseRef: x.case_ref,
        state: x.state,
        outcome: x.outcome,
        purpose: x.purpose,
        createdAt: x.created_at,
        agentId: lower(x.agent_id),
        agentName: x.agent_name,
        candidateNo: x.candidate_no,
      }));
    });
  }

  /** A review applies to the exact snapshot the clinician saw; a changed snapshot is a conflict. */
  async review(user: StudioUser, runId: string, body: { findingIndex: number; action: string; reason?: string | null; snapshotHash: string }) {
    if (!REVIEW_ACTIONS.has(body.action)) throw new AppError(422, "bad_action", "action must be acknowledge, dismiss or defer");
    if ((body.action === "dismiss" || body.action === "defer") && !String(body.reason ?? "").trim()) throw new AppError(422, "reason_required", "Give a reason to dismiss or defer");
    return withTenant(this.db, user.tenantId, async (tx) => {
      const r = (
        await new sql.Request(tx)
          .input("id", sql.UniqueIdentifier, runId)
          .query("SELECT r.result, s.content_hash FROM studio.agent_runs r JOIN studio.input_snapshots s ON s.id = r.snapshot_id WHERE r.id = @id")
      ).recordset[0];
      if (!r) throw new AppError(404, "not_found", "Run not found");
      if (r.content_hash !== body.snapshotHash) throw new AppError(409, "stale_snapshot", "The run's inputs changed; request a new evaluation");
      const result = JSON.parse(String(r.result)) as RunResult;
      const finding = result.findings[body.findingIndex];
      if (!finding) throw new AppError(422, "bad_finding", "No such finding");
      if (!finding.allowedActions.includes(body.action)) throw new AppError(422, "action_not_allowed", `${body.action} is not allowed for this finding`);
      await new sql.Request(tx)
        .input("tenant", sql.UniqueIdentifier, user.tenantId)
        .input("run", sql.UniqueIdentifier, runId)
        .input("idx", sql.Int, body.findingIndex)
        .input("code", sql.NVarChar(60), finding.code)
        .input("action", sql.NVarChar(20), body.action)
        .input("reason", sql.NVarChar(1000), body.reason?.trim() || null)
        .input("hash", sql.NVarChar(80), body.snapshotHash)
        .input("user", sql.UniqueIdentifier, user.id)
        .query(
          `INSERT INTO studio.run_reviews (tenant_id, run_id, finding_index, finding_code, action, reason, snapshot_hash, created_by)
           VALUES (@tenant, @run, @idx, @code, @action, @reason, @hash, @user)`,
        );
      await writeAudit(tx, { tenantId: user.tenantId, userId: user.id, action: `run.finding_${body.action}`, entityType: "agent_run", entityId: runId, details: { findingIndex: body.findingIndex, code: finding.code } });
      return { ok: true };
    });
  }
}
