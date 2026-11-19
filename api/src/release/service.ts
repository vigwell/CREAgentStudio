/**
 * Release lifecycle (spec rev 7 §11, §20):
 *   draft → candidate → tests passed → independently approved → active → retired / withdrawn.
 * Saved test cases run in memory against the immutable candidate. Approval needs
 * a passing run of the current suite on that exact manifest hash, by someone
 * other than the candidate's author, with every bound source still approved.
 * Activation rechecks all of that in one transaction and keeps one active
 * version per agent; activating an earlier approved version is the rollback.
 */
import sql from "mssql";
import type { Db } from "../db/pool.js";
import { withTenant } from "../db/tenant.js";
import { AppError } from "../errors.js";
import { writeAudit } from "../services/audit.js";
import type { StudioUser } from "../services/users.js";
import { loadKnowledge } from "../runtime/service.js";
import type { Manifest } from "../runtime/engine.js";
import { manifestDiff, runCase, type CaseResult, type Expected, type TestInputs } from "./testing.js";

const AUTHORS = new Set(["admin", "author", "approver"]);
const APPROVERS = new Set(["admin", "approver"]);
const OUTCOMES = new Set(["findings", "needs_input", "needs_review", "not_applicable", "blocked", "unavailable"]);
const STATES = new Set(["completed", "skipped", "awaiting_input", "blocked", "failed", "not_reached"]);
const lower = (x: unknown) => (x ? String(x).toLowerCase() : null);

function requireRole(user: StudioUser, allowed: Set<string>, what: string) {
  if (!allowed.has(user.role)) throw new AppError(403, "forbidden", `Your role (${user.role}) cannot ${what}`);
}

export interface TestCaseInput {
  name: string;
  inputs: TestInputs;
  expected: Expected;
  version?: number;
}

function checkTestCase(tc: TestCaseInput): TestCaseInput {
  const name = String(tc.name ?? "").trim();
  if (!name) throw new AppError(422, "name_required", "Give the test case a name");
  if (!tc.inputs || typeof tc.inputs.manualValues !== "object" || tc.inputs.manualValues === null) throw new AppError(422, "bad_inputs", "inputs.manualValues is required");
  if (!tc.expected || !OUTCOMES.has(tc.expected.outcome)) throw new AppError(422, "bad_expected", "expected.outcome must be a run outcome");
  for (const s of tc.expected.path ?? []) {
    if (!s.nodeId || !STATES.has(s.state)) throw new AppError(422, "bad_expected", "Each expected step needs a block and a state");
  }
  return { ...tc, name };
}

function testCaseOut(x: Record<string, unknown>) {
  return {
    id: lower(x.id)!,
    name: String(x.name),
    inputs: JSON.parse(String(x.inputs)) as TestInputs,
    expected: JSON.parse(String(x.expected)) as Expected,
    version: Number(x.version),
    updatedAt: x.updated_at,
  };
}

export class ReleaseService {
  constructor(private readonly db: Db) {}

  // ------------------------------------------------------------ test cases

  async listTestCases(user: StudioUser, agentId: string) {
    return withTenant(this.db, user.tenantId, async (tx) => {
      const r = await new sql.Request(tx)
        .input("agent", sql.UniqueIdentifier, agentId)
        .query("SELECT * FROM studio.agent_test_cases WHERE agent_id = @agent AND deleted_at IS NULL ORDER BY name");
      return r.recordset.map(testCaseOut);
    });
  }

  async createTestCase(user: StudioUser, agentId: string, input: TestCaseInput) {
    requireRole(user, AUTHORS, "edit test cases");
    const tc = checkTestCase(input);
    return withTenant(this.db, user.tenantId, async (tx) => {
      const agent = (await new sql.Request(tx).input("id", sql.UniqueIdentifier, agentId).query("SELECT kind FROM studio.agents WHERE id = @id")).recordset[0];
      if (!agent) throw new AppError(404, "not_found", "Agent not found");
      if (agent.kind !== "cds") throw new AppError(422, "not_cds", "Test cases run for CDS agents; voice agents are tested on calls");
      const r = await new sql.Request(tx)
        .input("tenant", sql.UniqueIdentifier, user.tenantId)
        .input("agent", sql.UniqueIdentifier, agentId)
        .input("name", sql.NVarChar(200), tc.name)
        .input("inputs", sql.NVarChar(sql.MAX), JSON.stringify(tc.inputs))
        .input("expected", sql.NVarChar(sql.MAX), JSON.stringify(tc.expected))
        .input("user", sql.UniqueIdentifier, user.id)
        .query(
          `INSERT INTO studio.agent_test_cases (tenant_id, agent_id, name, inputs, expected, created_by, updated_by)
           OUTPUT inserted.* VALUES (@tenant, @agent, @name, @inputs, @expected, @user, @user)`,
        );
      const out = testCaseOut(r.recordset[0]);
      await writeAudit(tx, { tenantId: user.tenantId, userId: user.id, action: "agent.test_case_created", entityType: "agent_test_case", entityId: out.id, details: { agentId } });
      return out;
    });
  }

  async updateTestCase(user: StudioUser, agentId: string, testCaseId: string, input: TestCaseInput) {
    requireRole(user, AUTHORS, "edit test cases");
    const tc = checkTestCase(input);
    return withTenant(this.db, user.tenantId, async (tx) => {
      const r = await new sql.Request(tx)
        .input("id", sql.UniqueIdentifier, testCaseId)
        .input("agent", sql.UniqueIdentifier, agentId)
        .input("version", sql.Int, Number(input.version ?? 0))
        .input("name", sql.NVarChar(200), tc.name)
        .input("inputs", sql.NVarChar(sql.MAX), JSON.stringify(tc.inputs))
        .input("expected", sql.NVarChar(sql.MAX), JSON.stringify(tc.expected))
        .input("user", sql.UniqueIdentifier, user.id)
        .query(
          `UPDATE studio.agent_test_cases SET name = @name, inputs = @inputs, expected = @expected, version = version + 1,
             updated_by = @user, updated_at = SYSUTCDATETIME()
           OUTPUT inserted.* WHERE id = @id AND agent_id = @agent AND deleted_at IS NULL AND version = @version`,
        );
      if (!r.recordset.length) {
        const exists = (await new sql.Request(tx).input("id", sql.UniqueIdentifier, testCaseId).query("SELECT version FROM studio.agent_test_cases WHERE id = @id AND deleted_at IS NULL")).recordset[0];
        if (!exists) throw new AppError(404, "not_found", "Test case not found");
        throw new AppError(409, "stale_test_case", "Someone else changed this test case; reload it");
      }
      await writeAudit(tx, { tenantId: user.tenantId, userId: user.id, action: "agent.test_case_updated", entityType: "agent_test_case", entityId: testCaseId, details: { agentId } });
      return testCaseOut(r.recordset[0]);
    });
  }

  async deleteTestCase(user: StudioUser, agentId: string, testCaseId: string) {
    requireRole(user, AUTHORS, "edit test cases");
    return withTenant(this.db, user.tenantId, async (tx) => {
      const r = await new sql.Request(tx)
        .input("id", sql.UniqueIdentifier, testCaseId)
        .input("agent", sql.UniqueIdentifier, agentId)
        .input("user", sql.UniqueIdentifier, user.id)
        .query("UPDATE studio.agent_test_cases SET deleted_at = SYSUTCDATETIME(), updated_by = @user WHERE id = @id AND agent_id = @agent AND deleted_at IS NULL");
      if (!r.rowsAffected[0]) throw new AppError(404, "not_found", "Test case not found");
      await writeAudit(tx, { tenantId: user.tenantId, userId: user.id, action: "agent.test_case_deleted", entityType: "agent_test_case", entityId: testCaseId, details: { agentId } });
      return { ok: true };
    });
  }

  // ------------------------------------------------------------ candidates

  private async candidateRow(tx: sql.Transaction, candidateId: string, lock = false) {
    const r = (
      await new sql.Request(tx).input("id", sql.UniqueIdentifier, candidateId).query(
        `SELECT c.*, a.kind, a.name AS agent_name FROM studio.agent_candidates c ${lock ? "WITH (UPDLOCK, HOLDLOCK)" : ""}
         JOIN studio.agents a ON a.id = c.agent_id WHERE c.id = @id`,
      )
    ).recordset[0] as Record<string, unknown> | undefined;
    if (!r) throw new AppError(404, "not_found", "Candidate not found");
    return r;
  }

  /** Every source the candidate binds is still approved (and every clinic profile). */
  private async ineligible(tx: sql.Transaction, manifest: Manifest & { sourceBindings?: string[]; clinicProfiles?: string[] }): Promise<string[]> {
    const reasons: string[] = [];
    const knowledge = await loadKnowledge(tx, manifest.sourceBindings ?? []);
    for (const id of manifest.sourceBindings ?? []) {
      const k = knowledge.get(id);
      if (!k) reasons.push(`knowledge ${id} is missing`);
      else if (k.status !== "approved") reasons.push(`${k.sourceName} is ${k.status}`);
    }
    for (const id of manifest.clinicProfiles ?? []) {
      const p = (await new sql.Request(tx).input("id", sql.UniqueIdentifier, id).query("SELECT name, status FROM studio.clinic_exam_profiles WHERE id = @id")).recordset[0];
      if (!p) reasons.push(`clinic profile ${id} is missing`);
      else if (p.status !== "approved") reasons.push(`${p.name} is ${p.status}`);
    }
    return reasons;
  }

  async listCandidates(user: StudioUser, agentId: string) {
    return withTenant(this.db, user.tenantId, async (tx) => {
      const r = await new sql.Request(tx).input("agent", sql.UniqueIdentifier, agentId).query(
        `SELECT c.id, c.candidate_no, c.manifest_hash, c.draft_version, c.status, c.status_reason, c.created_by, c.created_at,
                c.approved_by, c.approved_at, c.activated_by, c.activated_at,
                t.id AS last_test_id, t.passed AS last_passed, t.case_count, t.failed_count, t.created_at AS tested_at, t.manifest_hash AS tested_hash
         FROM studio.agent_candidates c
         OUTER APPLY (SELECT TOP 1 * FROM studio.candidate_test_runs x WHERE x.candidate_id = c.id ORDER BY x.created_at DESC) t
         WHERE c.agent_id = @agent ORDER BY c.candidate_no DESC`,
      );
      return r.recordset.map((x: Record<string, unknown>) => ({
        id: lower(x.id)!,
        candidateNo: Number(x.candidate_no),
        manifestHash: String(x.manifest_hash),
        draftVersion: Number(x.draft_version),
        status: String(x.status),
        statusReason: (x.status_reason as string) ?? null,
        createdBy: lower(x.created_by),
        createdAt: x.created_at,
        approvedBy: lower(x.approved_by),
        approvedAt: x.approved_at,
        activatedAt: x.activated_at,
        lastTest: x.last_test_id
          ? { id: lower(x.last_test_id), passed: !!x.last_passed, caseCount: Number(x.case_count), failedCount: Number(x.failed_count), at: x.tested_at }
          : null,
      }));
    });
  }

  /** Run the agent's saved cases against this candidate and keep the result. */
  async runTests(user: StudioUser, candidateId: string) {
    requireRole(user, AUTHORS, "run tests");
    return withTenant(this.db, user.tenantId, async (tx) => {
      const c = await this.candidateRow(tx, candidateId);
      if (c.kind !== "cds") throw new AppError(422, "not_cds", "Test cases run for CDS agents; voice agents are tested on calls");
      if (c.status === "withdrawn") throw new AppError(409, "candidate_withdrawn", "This candidate was withdrawn");
      const manifest = JSON.parse(String(c.manifest)) as Manifest & { sourceBindings?: string[] };
      const cases = (
        await new sql.Request(tx)
          .input("agent", sql.UniqueIdentifier, c.agent_id)
          .query("SELECT * FROM studio.agent_test_cases WHERE agent_id = @agent AND deleted_at IS NULL ORDER BY name")
      ).recordset.map(testCaseOut);
      if (!cases.length) throw new AppError(422, "no_test_cases", "Add at least one test case first");
      const knowledge = await loadKnowledge(tx, manifest.sourceBindings ?? []);
      const now = new Date().toISOString();
      const results: CaseResult[] = cases.map((tc) => runCase(manifest, knowledge, tc, user.id, now));
      const failed = results.filter((r) => !r.passed).length;
      const id = (
        await new sql.Request(tx)
          .input("tenant", sql.UniqueIdentifier, user.tenantId)
          .input("cand", sql.UniqueIdentifier, candidateId)
          .input("hash", sql.NVarChar(80), String(c.manifest_hash))
          .input("passed", sql.Bit, failed === 0)
          .input("count", sql.Int, results.length)
          .input("failed", sql.Int, failed)
          .input("results", sql.NVarChar(sql.MAX), JSON.stringify(results))
          .input("user", sql.UniqueIdentifier, user.id)
          .query<{ id: string }>(
            `INSERT INTO studio.candidate_test_runs (tenant_id, candidate_id, manifest_hash, passed, case_count, failed_count, results, run_by)
             OUTPUT inserted.id VALUES (@tenant, @cand, @hash, @passed, @count, @failed, @results, @user)`,
          )
      ).recordset[0].id.toLowerCase();
      await writeAudit(tx, { tenantId: user.tenantId, userId: user.id, action: "candidate.tested", entityType: "agent_candidate", entityId: candidateId, details: { testRunId: id, cases: results.length, failed } });
      return { id, candidateId, passed: failed === 0, caseCount: results.length, failedCount: failed, results };
    });
  }

  async testRun(user: StudioUser, candidateId: string) {
    return withTenant(this.db, user.tenantId, async (tx) => {
      const r = (
        await new sql.Request(tx)
          .input("cand", sql.UniqueIdentifier, candidateId)
          .query("SELECT TOP 1 * FROM studio.candidate_test_runs WHERE candidate_id = @cand ORDER BY created_at DESC")
      ).recordset[0];
      if (!r) return null;
      return { id: lower(r.id), candidateId, passed: !!r.passed, caseCount: r.case_count, failedCount: r.failed_count, results: JSON.parse(String(r.results)) as CaseResult[], at: r.created_at };
    });
  }

  /**
   * Independent clinical approval of this exact candidate: tests passed on its
   * manifest hash with the current suite, approver ≠ author, sources still approved.
   */
  async approve(user: StudioUser, candidateId: string) {
    requireRole(user, APPROVERS, "approve candidates");
    return withTenant(this.db, user.tenantId, async (tx) => {
      const c = await this.candidateRow(tx, candidateId, true);
      if (c.status !== "candidate") throw new AppError(409, "bad_state", `Only a candidate can be approved (now ${c.status})`);
      if (lower(c.created_by) === user.id) throw new AppError(403, "not_independent", "The author of a candidate cannot approve it");
      const t = (
        await new sql.Request(tx)
          .input("cand", sql.UniqueIdentifier, candidateId)
          .query("SELECT TOP 1 id, passed, manifest_hash, created_at, results FROM studio.candidate_test_runs WHERE candidate_id = @cand ORDER BY created_at DESC")
      ).recordset[0];
      if (!t || !t.passed || t.manifest_hash !== c.manifest_hash) throw new AppError(409, "tests_required", "Run the test cases on this candidate and get them all passing first");
      // A test case changed or added after the run means the run no longer covers the suite.
      const newer = (
        await new sql.Request(tx)
          .input("agent", sql.UniqueIdentifier, c.agent_id)
          .input("at", sql.DateTime2(3), t.created_at)
          .query("SELECT COUNT(*) AS n FROM studio.agent_test_cases WHERE agent_id = @agent AND updated_at > @at")
      ).recordset[0].n;
      if (newer > 0) throw new AppError(409, "tests_outdated", "Test cases changed since the last run; run them again");
      const reasons = await this.ineligible(tx, JSON.parse(String(c.manifest)));
      if (reasons.length) throw new AppError(409, "not_eligible", `Not eligible: ${reasons.join("; ")}`);
      await new sql.Request(tx)
        .input("id", sql.UniqueIdentifier, candidateId)
        .input("user", sql.UniqueIdentifier, user.id)
        .input("test", sql.UniqueIdentifier, t.id)
        .query("UPDATE studio.agent_candidates SET status = N'approved', approved_by = @user, approved_at = SYSUTCDATETIME(), test_run_id = @test WHERE id = @id");
      await writeAudit(tx, { tenantId: user.tenantId, userId: user.id, action: "candidate.approved", entityType: "agent_candidate", entityId: candidateId, details: { manifestHash: c.manifest_hash, testRunId: lower(t.id) } });
      return { id: candidateId, status: "approved" };
    });
  }

  /**
   * Make an approved version the active one (or an earlier one again: rollback).
   * One transaction: recheck eligibility, retire the current active version, activate this one.
   */
  async activate(user: StudioUser, candidateId: string) {
    requireRole(user, APPROVERS, "activate versions");
    return withTenant(this.db, user.tenantId, async (tx) => {
      const c = await this.candidateRow(tx, candidateId, true);
      if (c.status !== "approved" && c.status !== "retired") throw new AppError(409, "bad_state", `Only an approved version can be activated (now ${c.status})`);
      if (!c.approved_by) throw new AppError(409, "not_approved", "This version was never approved");
      const reasons = await this.ineligible(tx, JSON.parse(String(c.manifest)));
      if (reasons.length) throw new AppError(409, "not_eligible", `Not eligible: ${reasons.join("; ")}`);
      const previous = (
        await new sql.Request(tx)
          .input("agent", sql.UniqueIdentifier, c.agent_id)
          .query("SELECT id FROM studio.agent_candidates WITH (UPDLOCK, HOLDLOCK) WHERE agent_id = @agent AND status = N'active'")
      ).recordset[0];
      if (previous) {
        await new sql.Request(tx).input("id", sql.UniqueIdentifier, previous.id).query("UPDATE studio.agent_candidates SET status = N'retired' WHERE id = @id");
      }
      await new sql.Request(tx)
        .input("id", sql.UniqueIdentifier, candidateId)
        .input("user", sql.UniqueIdentifier, user.id)
        .query("UPDATE studio.agent_candidates SET status = N'active', activated_by = @user, activated_at = SYSUTCDATETIME() WHERE id = @id");
      await writeAudit(tx, {
        tenantId: user.tenantId,
        userId: user.id,
        action: c.status === "retired" ? "candidate.rolled_back" : "candidate.activated",
        entityType: "agent_candidate",
        entityId: candidateId,
        details: { agentId: lower(c.agent_id), previous: lower(previous?.id), manifestHash: c.manifest_hash },
      });
      return { id: candidateId, status: "active", previous: lower(previous?.id) };
    });
  }

  /** Stop a version for good: no new runs; if it was active the agent has no active version. */
  async withdraw(user: StudioUser, candidateId: string, reason: string) {
    requireRole(user, APPROVERS, "withdraw versions");
    if (!String(reason ?? "").trim()) throw new AppError(422, "reason_required", "Give a reason to withdraw");
    return withTenant(this.db, user.tenantId, async (tx) => {
      const c = await this.candidateRow(tx, candidateId, true);
      if (c.status === "withdrawn") throw new AppError(409, "bad_state", "Already withdrawn");
      await new sql.Request(tx)
        .input("id", sql.UniqueIdentifier, candidateId)
        .input("reason", sql.NVarChar(500), reason.trim().slice(0, 500))
        .query("UPDATE studio.agent_candidates SET status = N'withdrawn', status_reason = @reason WHERE id = @id");
      await writeAudit(tx, { tenantId: user.tenantId, userId: user.id, action: "candidate.withdrawn", entityType: "agent_candidate", entityId: candidateId, details: { wasActive: c.status === "active" } });
      return { id: candidateId, status: "withdrawn" };
    });
  }

  /** What changed against another version (default: the active one) — shown before approval. */
  async diff(user: StudioUser, candidateId: string, againstId?: string | null) {
    return withTenant(this.db, user.tenantId, async (tx) => {
      const c = await this.candidateRow(tx, candidateId);
      let other: Record<string, unknown> | undefined;
      if (againstId) other = await this.candidateRow(tx, againstId);
      else
        other = (
          await new sql.Request(tx)
            .input("agent", sql.UniqueIdentifier, c.agent_id)
            .query("SELECT * FROM studio.agent_candidates WHERE agent_id = @agent AND status = N'active'")
        ).recordset[0];
      return {
        against: other ? { id: lower(other.id), candidateNo: Number(other.candidate_no) } : null,
        ...manifestDiff(other ? JSON.parse(String(other.manifest)) : null, JSON.parse(String(c.manifest))),
      };
    });
  }
}
