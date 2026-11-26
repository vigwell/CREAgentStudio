/**
 * Agent authoring service: agents, the editable draft (optimistic version),
 * compilation against the current knowledge / profile states, immutable
 * candidates, and clinic & exam profiles (voice).
 */
import sql from "mssql";
import type { Db } from "../db/pool.js";
import { withTenant } from "../db/tenant.js";
import { AppError } from "../errors.js";
import { writeAudit } from "../services/audit.js";
import type { StudioUser } from "../services/users.js";
import { effectiveStatus } from "../knowledge/service.js";
import { BLOCK_BY_TYPE, type AgentKind } from "./blocks.js";
import { compile, type AgentGraph, type CompileResult, type PromptRef } from "./compiler.js";
import { OPTIONAL_RULES, type AgentProhibitions } from "./policy.js";

const AUTHORS = new Set(["admin", "author", "approver"]);
const APPROVERS = new Set(["admin", "approver"]);

function requireRole(user: StudioUser, allowed: Set<string>, what: string) {
  if (!allowed.has(user.role)) throw new AppError(403, "forbidden", `Your role (${user.role}) cannot ${what}`);
}

const lower = (x: unknown) => (x ? String(x).toLowerCase() : null);

export interface AgentInput {
  kind: AgentKind;
  name: string;
  intendedUse: string;
  scope: Record<string, unknown>;
  executionMode?: string;
}

export interface DraftInput {
  version: number;
  graph: AgentGraph;
  agentPrompt: PromptRef | null;
  prohibitions: AgentProhibitions;
}

/** A new agent starts with Start → final block, ready to extend. */
function starterGraph(kind: AgentKind): AgentGraph {
  if (kind === "cds") {
    return {
      nodes: [
        { id: "start", type: "start", label: "Request", position: { x: 80, y: 200 } },
        { id: "final", type: "final_synthesis", label: "Review summary", executionKind: "ai", outputCategories: ["missing_data_notice"], position: { x: 520, y: 200 } },
      ],
      edges: [{ id: "e-start-final", from: "start", port: "out", to: "final" }],
    };
  }
  return {
    nodes: [
      { id: "start", type: "start", label: "Incoming call", position: { x: 80, y: 200 } },
      { id: "staff", type: "transfer_staff", label: "Transfer to staff", position: { x: 520, y: 200 } },
    ],
    edges: [{ id: "e-start-staff", from: "start", port: "out", to: "staff" }],
  };
}

/** Shape checks on a saved draft (semantics are the compiler's job). */
function checkDraft(d: DraftInput) {
  if (!Array.isArray(d.graph?.nodes) || !Array.isArray(d.graph?.edges)) throw new AppError(400, "bad_graph", "graph.nodes and graph.edges are required");
  if (d.graph.nodes.length > 60 || d.graph.edges.length > 120) throw new AppError(400, "too_large", "An agent graph is limited to 60 blocks");
  for (const n of d.graph.nodes) {
    if (!BLOCK_BY_TYPE.has(n.type)) throw new AppError(400, "bad_graph", `Unknown block type "${n.type}"`);
  }
  for (const id of d.prohibitions?.optional ?? []) {
    if (!OPTIONAL_RULES.some((r) => r.id === id)) throw new AppError(400, "bad_prohibition", `Unknown optional prohibition ${id}`);
  }
}

/**
 * The test-run inputs a frozen version reads; null = all of them. Agents built
 * only from the referral blocks read the referral text, age and the pediatric
 * flag; any patient, lookup or decision block may read any patient value.
 */
export function inputFieldsOf(manifest: unknown): string[] | null {
  try {
    const m = typeof manifest === "string" ? JSON.parse(manifest) : manifest;
    const types = new Set<string>((m?.nodes ?? []).map((n: { type: string }) => n.type));
    if (["patient_service", "protocol_lookup", "guidance_lookup", "decision"].some((t) => types.has(t))) return null;
    return types.has("anatomy_detection") ? ["ageYears", "pediatric", "clinicalNote"] : ["clinicalNote"];
  } catch {
    return null;
  }
}

export class AgentService {
  constructor(
    private readonly db: Db,
    /** The AI deployment in use; frozen into new versions that have AI steps. */
    private readonly aiModel: { provider: string; deployment: string } | null = null,
  ) {}

  async list(user: StudioUser) {
    return withTenant(this.db, user.tenantId, async (tx) => {
      const r = await new sql.Request(tx).query(
        `SELECT a.id, a.kind, a.name, a.intended_use, a.execution_mode, d.version, d.updated_at,
                (SELECT COUNT(*) FROM studio.agent_candidates c WHERE c.agent_id = a.id) AS candidates
         FROM studio.agents a JOIN studio.agent_drafts d ON d.agent_id = a.id ORDER BY a.name`,
      );
      return r.recordset.map((x: Record<string, unknown>) => ({
        id: lower(x.id),
        kind: x.kind,
        name: x.name,
        intendedUse: x.intended_use,
        executionMode: x.execution_mode,
        draftVersion: x.version,
        updatedAt: x.updated_at,
        candidates: x.candidates,
      }));
    });
  }

  async create(user: StudioUser, input: AgentInput) {
    requireRole(user, AUTHORS, "create agents");
    if (input.kind !== "cds" && input.kind !== "voice") throw new AppError(400, "bad_kind", "kind must be cds or voice");
    const name = String(input.name ?? "").trim();
    if (!name) throw new AppError(400, "name_required", "Name is required");
    if (!String(input.intendedUse ?? "").trim()) throw new AppError(400, "intended_use_required", "Intended use is required");
    const executionMode = input.executionMode ?? (input.kind === "cds" ? "standalone_cds" : "voice_scheduling");
    return withTenant(this.db, user.tenantId, async (tx) => {
      const dup = await new sql.Request(tx).input("name", sql.NVarChar(200), name).query("SELECT 1 AS x FROM studio.agents WHERE name = @name");
      if (dup.recordset.length) throw new AppError(409, "duplicate", `An agent named "${name}" exists`);
      const r = await new sql.Request(tx)
        .input("tenant", sql.UniqueIdentifier, user.tenantId)
        .input("kind", sql.NVarChar(10), input.kind)
        .input("name", sql.NVarChar(200), name)
        .input("use", sql.NVarChar(2000), input.intendedUse.trim())
        .input("scope", sql.NVarChar(sql.MAX), JSON.stringify(input.scope ?? {}))
        .input("mode", sql.NVarChar(40), executionMode)
        .input("user", sql.UniqueIdentifier, user.id)
        .query<{ id: string }>(
          `INSERT INTO studio.agents (tenant_id, kind, name, intended_use, scope, execution_mode, created_by)
           OUTPUT inserted.id VALUES (@tenant, @kind, @name, @use, @scope, @mode, @user)`,
        );
      const id = r.recordset[0].id.toLowerCase();
      await new sql.Request(tx)
        .input("id", sql.UniqueIdentifier, id)
        .input("tenant", sql.UniqueIdentifier, user.tenantId)
        .input("graph", sql.NVarChar(sql.MAX), JSON.stringify(starterGraph(input.kind)))
        .input("prohib", sql.NVarChar(sql.MAX), JSON.stringify({ optional: [], custom: [] }))
        .input("user", sql.UniqueIdentifier, user.id)
        .query("INSERT INTO studio.agent_drafts (agent_id, tenant_id, graph, prohibitions, updated_by) VALUES (@id, @tenant, @graph, @prohib, @user)");
      await writeAudit(tx, { tenantId: user.tenantId, userId: user.id, action: "agent.created", entityType: "agent", entityId: id, details: { kind: input.kind, name } });
      return { id, kind: input.kind, name };
    });
  }

  async get(user: StudioUser, agentId: string) {
    return withTenant(this.db, user.tenantId, async (tx) => {
      const r = (
        await new sql.Request(tx).input("id", sql.UniqueIdentifier, agentId).query(
          `SELECT a.*, d.graph, d.agent_prompt, d.prohibitions, d.version, d.updated_at
           FROM studio.agents a JOIN studio.agent_drafts d ON d.agent_id = a.id WHERE a.id = @id`,
        )
      ).recordset[0] as Record<string, unknown> | undefined;
      if (!r) throw new AppError(404, "not_found", "Agent not found");
      return {
        id: lower(r.id)!,
        kind: r.kind as AgentKind,
        name: String(r.name),
        intendedUse: String(r.intended_use),
        scope: JSON.parse(String(r.scope)) as Record<string, unknown>,
        executionMode: String(r.execution_mode),
        draft: {
          version: Number(r.version),
          graph: JSON.parse(String(r.graph)) as AgentGraph,
          agentPrompt: r.agent_prompt ? (JSON.parse(String(r.agent_prompt)) as PromptRef) : null,
          prohibitions: JSON.parse(String(r.prohibitions)) as AgentProhibitions,
          updatedAt: r.updated_at,
        },
      };
    });
  }

  /** Save the draft if nobody saved in between (version = what the editor loaded). */
  async saveDraft(user: StudioUser, agentId: string, d: DraftInput) {
    requireRole(user, AUTHORS, "edit agents");
    checkDraft(d);
    return withTenant(this.db, user.tenantId, async (tx) => {
      const r = await new sql.Request(tx)
        .input("id", sql.UniqueIdentifier, agentId)
        .input("version", sql.Int, d.version)
        .input("graph", sql.NVarChar(sql.MAX), JSON.stringify(d.graph))
        .input("prompt", sql.NVarChar(sql.MAX), d.agentPrompt ? JSON.stringify(d.agentPrompt) : null)
        .input("prohib", sql.NVarChar(sql.MAX), JSON.stringify(d.prohibitions ?? { optional: [], custom: [] }))
        .input("user", sql.UniqueIdentifier, user.id)
        .query<{ version: number }>(
          `UPDATE studio.agent_drafts SET graph = @graph, agent_prompt = @prompt, prohibitions = @prohib,
             version = version + 1, updated_by = @user, updated_at = SYSUTCDATETIME()
           OUTPUT inserted.version
           WHERE agent_id = @id AND version = @version`,
        );
      if (!r.recordset.length) {
        const exists = await new sql.Request(tx).input("id", sql.UniqueIdentifier, agentId).query("SELECT version FROM studio.agent_drafts WHERE agent_id = @id");
        if (!exists.recordset.length) throw new AppError(404, "not_found", "Agent not found");
        throw new AppError(409, "stale_draft", "Someone else saved this agent meanwhile; reload to see their changes");
      }
      await writeAudit(tx, { tenantId: user.tenantId, userId: user.id, action: "agent.draft_saved", entityType: "agent", entityId: agentId, details: { version: r.recordset[0].version } });
      return { version: r.recordset[0].version };
    });
  }

  /** Compile the saved draft against the current knowledge and profile states. */
  async compileDraft(user: StudioUser, agentId: string): Promise<CompileResult & { draftVersion: number }> {
    const agent = await this.get(user, agentId);
    const g = agent.draft.graph;
    const knowledgeIds = [...new Set(g.nodes.flatMap((n) => (n.knowledgeRevisionId ? [n.knowledgeRevisionId] : [])))];
    const profileIds = [...new Set(g.nodes.flatMap((n) => (n.clinicProfileId ? [n.clinicProfileId] : [])))];
    const { knowledge, clinicProfiles } = await withTenant(this.db, user.tenantId, async (tx) => {
      const k = new Map<string, { status: string; kind: string }>();
      const p = new Map<string, { status: string }>();
      for (const id of knowledgeIds.filter((x) => /^[0-9a-f-]{36}$/i.test(x))) {
        const row = (
          await new sql.Request(tx).input("id", sql.UniqueIdentifier, id).query(
            "SELECT r.status, r.review_due, s.kind FROM studio.knowledge_revisions r JOIN studio.knowledge_sources s ON s.id = r.source_id WHERE r.id = @id",
          )
        ).recordset[0];
        if (row) k.set(id, { status: effectiveStatus(row.status, row.review_due), kind: row.kind });
      }
      for (const id of profileIds.filter((x) => /^[0-9a-f-]{36}$/i.test(x))) {
        const row = (await new sql.Request(tx).input("id", sql.UniqueIdentifier, id).query("SELECT status FROM studio.clinic_exam_profiles WHERE id = @id")).recordset[0];
        if (row) p.set(id, { status: row.status });
      }
      return { knowledge: k, clinicProfiles: p };
    });
    const result = compile(g, {
      agentId: agent.id,
      kind: agent.kind,
      scope: agent.scope,
      executionMode: agent.executionMode,
      agentPrompt: agent.draft.agentPrompt,
      prohibitions: agent.draft.prohibitions,
      knowledge,
      clinicProfiles,
      aiModel: this.aiModel,
    });
    return { ...result, draftVersion: agent.draft.version };
  }

  /** Freeze a valid draft as an immutable candidate (approval comes in the release flow). */
  async createCandidate(user: StudioUser, agentId: string) {
    requireRole(user, AUTHORS, "create candidates");
    const result = await this.compileDraft(user, agentId);
    if (!result.ok) throw new AppError(422, "invalid_graph", `${result.issues.length} problem(s) must be fixed first`);
    return withTenant(this.db, user.tenantId, async (tx) => {
      const next = await new sql.Request(tx)
        .input("agent", sql.UniqueIdentifier, agentId)
        .query<{ n: number }>("SELECT ISNULL(MAX(candidate_no), 0) + 1 AS n FROM studio.agent_candidates WITH (UPDLOCK, HOLDLOCK) WHERE agent_id = @agent");
      const no = next.recordset[0].n;
      const r = await new sql.Request(tx)
        .input("tenant", sql.UniqueIdentifier, user.tenantId)
        .input("agent", sql.UniqueIdentifier, agentId)
        .input("no", sql.Int, no)
        .input("manifest", sql.NVarChar(sql.MAX), JSON.stringify(result.manifest))
        .input("hash", sql.NVarChar(80), result.manifestHash)
        .input("draft", sql.Int, result.draftVersion)
        .input("user", sql.UniqueIdentifier, user.id)
        .query<{ id: string }>(
          `INSERT INTO studio.agent_candidates (tenant_id, agent_id, candidate_no, manifest, manifest_hash, draft_version, created_by)
           OUTPUT inserted.id VALUES (@tenant, @agent, @no, @manifest, @hash, @draft, @user)`,
        );
      const id = r.recordset[0].id.toLowerCase();
      await writeAudit(tx, { tenantId: user.tenantId, userId: user.id, action: "agent.candidate_created", entityType: "agent_candidate", entityId: id, details: { agentId, candidateNo: no, manifestHash: result.manifestHash } });
      return { id, candidateNo: no, manifestHash: result.manifestHash };
    });
  }

  async candidates(user: StudioUser, agentId: string) {
    return withTenant(this.db, user.tenantId, async (tx) => {
      const r = await new sql.Request(tx)
        .input("agent", sql.UniqueIdentifier, agentId)
        .query("SELECT id, candidate_no, manifest, manifest_hash, draft_version, status, created_at FROM studio.agent_candidates WHERE agent_id = @agent ORDER BY candidate_no DESC");
      return r.recordset.map((x: Record<string, unknown>) => ({
        id: lower(x.id),
        candidateNo: x.candidate_no,
        manifestHash: x.manifest_hash,
        draftVersion: x.draft_version,
        status: x.status,
        createdAt: x.created_at,
        inputFields: inputFieldsOf(x.manifest),
      }));
    });
  }

  // ------------------------------------------------------------ clinic & exam profiles

  async listProfiles(user: StudioUser) {
    return withTenant(this.db, user.tenantId, async (tx) => {
      const r = await new sql.Request(tx).query("SELECT * FROM studio.clinic_exam_profiles ORDER BY name, revision_no DESC");
      return r.recordset.map(profileOut);
    });
  }

  async createProfile(user: StudioUser, input: ProfileInput, profileKey?: string) {
    requireRole(user, AUTHORS, "create clinic profiles");
    const p = checkProfile(input);
    return withTenant(this.db, user.tenantId, async (tx) => {
      let key = profileKey ?? null;
      let no = 1;
      if (key) {
        const prev = await new sql.Request(tx).input("key", sql.UniqueIdentifier, key).query<{ n: number }>("SELECT ISNULL(MAX(revision_no), 0) AS n FROM studio.clinic_exam_profiles WHERE profile_key = @key");
        if (!prev.recordset[0].n) throw new AppError(404, "not_found", "Profile not found");
        no = prev.recordset[0].n + 1;
      }
      const r = await new sql.Request(tx)
        .input("tenant", sql.UniqueIdentifier, user.tenantId)
        .input("key", sql.UniqueIdentifier, key)
        .input("no", sql.Int, no)
        .input("name", sql.NVarChar(200), p.name)
        .input("site", sql.NVarChar(100), p.site)
        .input("dept", sql.NVarChar(100), p.department)
        .input("sub", sql.NVarChar(100), p.subdepartment ?? null)
        .input("ris", sql.NVarChar(50), p.risProcedureCode)
        .input("protoRev", sql.UniqueIdentifier, p.protocolRevisionId ?? null)
        .input("protoCode", sql.NVarChar(100), p.protocolCode ?? null)
        .input("questions", sql.NVarChar(sql.MAX), JSON.stringify(p.questions ?? []))
        .input("horizon", sql.Int, p.horizonDays)
        .input("instr", sql.UniqueIdentifier, p.instructionRevisionId ?? null)
        .input("user", sql.UniqueIdentifier, user.id)
        .query<{ id: string; profile_key: string }>(
          `INSERT INTO studio.clinic_exam_profiles
             (tenant_id, profile_key, revision_no, name, site, department, subdepartment, ris_procedure_code,
              protocol_revision_id, protocol_code, questions, horizon_days, instruction_revision_id, created_by)
           OUTPUT inserted.id, inserted.profile_key
           VALUES (@tenant, ISNULL(@key, NEWID()), @no, @name, @site, @dept, @sub, @ris, @protoRev, @protoCode, @questions, @horizon, @instr, @user)`,
        );
      const id = r.recordset[0].id.toLowerCase();
      await writeAudit(tx, { tenantId: user.tenantId, userId: user.id, action: "clinic_profile.created", entityType: "clinic_profile", entityId: id, details: { revisionNo: no, name: p.name } });
      return { id, profileKey: r.recordset[0].profile_key.toLowerCase(), revisionNo: no, status: "draft" };
    });
  }

  async approveProfile(user: StudioUser, id: string) {
    requireRole(user, APPROVERS, "approve clinic profiles");
    return withTenant(this.db, user.tenantId, async (tx) => {
      const row = (await new sql.Request(tx).input("id", sql.UniqueIdentifier, id).query("SELECT status, created_by FROM studio.clinic_exam_profiles WITH (UPDLOCK) WHERE id = @id")).recordset[0];
      if (!row) throw new AppError(404, "not_found", "Profile not found");
      if (row.status !== "draft") throw new AppError(409, "bad_state", `Only a draft can be approved (now ${row.status})`);
      if (lower(row.created_by) === user.id) throw new AppError(403, "not_independent", "The author of a profile cannot approve it");
      await new sql.Request(tx).input("id", sql.UniqueIdentifier, id).input("user", sql.UniqueIdentifier, user.id).query("UPDATE studio.clinic_exam_profiles SET status = N'approved', approved_by = @user, approved_at = SYSUTCDATETIME() WHERE id = @id");
      await writeAudit(tx, { tenantId: user.tenantId, userId: user.id, action: "clinic_profile.approved", entityType: "clinic_profile", entityId: id });
      return { id, status: "approved" };
    });
  }

  async withdrawProfile(user: StudioUser, id: string) {
    requireRole(user, APPROVERS, "withdraw clinic profiles");
    return withTenant(this.db, user.tenantId, async (tx) => {
      const r = await new sql.Request(tx).input("id", sql.UniqueIdentifier, id).query("UPDATE studio.clinic_exam_profiles SET status = N'withdrawn' OUTPUT inserted.id WHERE id = @id AND status <> N'withdrawn'");
      if (!r.recordset.length) throw new AppError(404, "not_found", "Profile not found or already withdrawn");
      await writeAudit(tx, { tenantId: user.tenantId, userId: user.id, action: "clinic_profile.withdrawn", entityType: "clinic_profile", entityId: id });
      return { id, status: "withdrawn" };
    });
  }
}

export interface ProfileInput {
  name: string;
  site: string;
  department: string;
  subdepartment?: string | null;
  risProcedureCode: string;
  protocolRevisionId?: string | null;
  protocolCode?: string | null;
  questions?: { id: string; text: string; answerType: "yes_no" | "number" | "text"; contraindicationIf?: unknown }[];
  horizonDays: number;
  instructionRevisionId?: string | null;
}

function checkProfile(p: ProfileInput): ProfileInput {
  for (const k of ["name", "site", "department", "risProcedureCode"] as const) {
    if (!String(p[k] ?? "").trim()) throw new AppError(400, "field_required", `${k} is required`);
  }
  if (!Number.isInteger(p.horizonDays) || p.horizonDays < 1 || p.horizonDays > 365) throw new AppError(400, "bad_horizon", "horizonDays must be 1-365");
  const ids = new Set<string>();
  for (const q of p.questions ?? []) {
    if (!q.id || !q.text?.trim()) throw new AppError(400, "bad_question", "Every question needs an id and text");
    if (ids.has(q.id)) throw new AppError(400, "bad_question", `Question id "${q.id}" repeats`);
    ids.add(q.id);
    if (!["yes_no", "number", "text"].includes(q.answerType)) throw new AppError(400, "bad_question", `Question "${q.id}": answerType must be yes_no, number or text`);
  }
  return { ...p, name: p.name.trim(), site: p.site.trim(), department: p.department.trim(), risProcedureCode: p.risProcedureCode.trim() };
}

function profileOut(x: Record<string, unknown>) {
  return {
    id: lower(x.id),
    profileKey: lower(x.profile_key),
    revisionNo: x.revision_no,
    name: x.name,
    site: x.site,
    department: x.department,
    subdepartment: x.subdepartment,
    risProcedureCode: x.ris_procedure_code,
    protocolRevisionId: lower(x.protocol_revision_id),
    protocolCode: x.protocol_code,
    questions: JSON.parse(String(x.questions)),
    horizonDays: x.horizon_days,
    instructionRevisionId: lower(x.instruction_revision_id),
    status: x.status,
    createdBy: lower(x.created_by),
    approvedBy: lower(x.approved_by),
  };
}
