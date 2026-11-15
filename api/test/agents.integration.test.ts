/**
 * Agent authoring over HTTP against XCreAgents: create, draft save with
 * optimistic version, compile against approved knowledge, immutable candidate,
 * clinic profile approval for voice, tenant isolation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import sql from "mssql";
import { loadConfig } from "../src/config.js";
import { createPool, type Db } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { withSystem, withTenant } from "../src/db/tenant.js";
import { buildApp } from "../src/app.js";
import { AuthError } from "../src/auth/creToken.js";

const hasDb = Boolean(process.env.DB_SERVER && process.env.DB_PASSWORD);
const TENANT_A = "00000000-0000-0000-0000-00000000a001";
const TENANT_B = "00000000-0000-0000-0000-00000000b002";
const run = randomUUID().slice(0, 8);
const people = {
  author: { oid: `ag-author-${run}`, tenant: TENANT_A, role: "author" },
  approver: { oid: `ag-approver-${run}`, tenant: TENANT_A, role: "approver" },
  other: { oid: `ag-other-${run}`, tenant: TENANT_B, role: "admin" },
} as const;
type Who = keyof typeof people;
let db: Db;
let app: ReturnType<typeof buildApp>;

const call = (who: Who, method: "GET" | "POST" | "PUT", url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${who}`, ...headers }, payload: payload as never });

async function approvedProtocolRevision(): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("CT 01");
  ws.addRow(["Protocol", "Indication code"]);
  ws.addRow(["CT-HEAD-01", "DEMO-STROKE"]);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const boundary = `b${run}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="p.xlsx"\r\n\r\n`),
    buf,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const fileId = (await call("author", "POST", "/knowledge/files", body, { "content-type": `multipart/form-data; boundary=${boundary}` })).json().fileId;
  const sourceId = (await call("author", "POST", "/knowledge/sources", { kind: "device_protocol", name: `Agent test protocols ${run}` })).json().id;
  const rev = (await call("author", "POST", `/knowledge/sources/${sourceId}/revisions`, { fileId, sheet: "CT 01", headerRow: 1, mapping: { Protocol: "protocolCode", "Indication code": "conditionCode" }, clinicalOwner: "Dr", reviewDue: "2099-01-01" })).json();
  await call("author", "POST", `/knowledge/revisions/${rev.id}/submit`);
  await call("approver", "POST", `/knowledge/revisions/${rev.id}/approve`);
  return rev.id;
}

describe.skipIf(!hasDb)("agent authoring (XCreAgents)", { timeout: 240_000 }, () => {
  beforeAll(async () => {
    db = await createPool(loadConfig());
    await migrate(db, undefined, () => {});
    await withSystem(db, async (tx) => {
      for (const p of Object.values(people)) {
        await new sql.Request(tx).input("t", p.tenant).input("oid", p.oid).input("role", p.role).query("INSERT INTO studio.users (tenant_id, cre_oid, display_name, role) VALUES (@t, @oid, @oid, @role)");
      }
    });
    app = buildApp({
      db,
      logLevel: "silent",
      verifyToken: async (token) => {
        const p = people[token as Who];
        if (!p) throw new AuthError("invalid token");
        return { oid: p.oid, email: null, name: p.oid };
      },
    });
  });

  afterAll(async () => {
    if (!db) return;
    await app?.close();
    await withSystem(db, async (tx) => {
      for (const p of Object.values(people)) await new sql.Request(tx).input("oid", p.oid).query("DELETE FROM studio.users WHERE cre_oid = @oid");
    });
    await db.close();
  });

  it("CDS: create, save with version check, compile, freeze an immutable candidate", async () => {
    const created = await call("author", "POST", "/agents", { kind: "cds", name: `CT referral check ${run}`, intendedUse: "Match CT referrals to the local protocol for clinician review", scope: { departmentId: "rad", deviceIds: ["CT-01"] } });
    expect(created.statusCode).toBe(201);
    const agentId = created.json().id;
    const agent = (await call("author", "GET", `/agents/${agentId}`)).json();
    expect(agent.draft.version).toBe(1);
    expect(agent.draft.graph.nodes.map((n: { type: string }) => n.type)).toEqual(["start", "final_synthesis"]);

    const starter = (await call("author", "POST", `/agents/${agentId}/compile`)).json();
    expect(starter.ok).toBe(false);
    expect(starter.issues.map((i: { code: string }) => i.code)).toEqual(expect.arrayContaining(["prompt_required", "agent_prompt_required"]));

    const proto = await approvedProtocolRevision();
    const draft = {
      version: 1,
      agentPrompt: { draftText: "Check CT referrals against the local protocol for clinician review." },
      prohibitions: { optional: ["P09"], custom: [] },
      graph: {
        nodes: [
          { id: "start", type: "start", label: "Referral", position: { x: 0, y: 0 } },
          { id: "patient", type: "patient_service", label: "Patient data" },
          { id: "hasInd", type: "decision", label: "Indication present?", condition: { nodeId: "patient", field: "hasIndication", operator: "eq", value: true } },
          { id: "proto", type: "protocol_lookup", label: "CT 01 protocol", knowledgeRevisionId: proto },
          { id: "ask", type: "instruction", label: "Ask for indication" },
          { id: "final", type: "final_synthesis", label: "Review summary", executionKind: "ai", prompt: { draftText: "Summarize the matched protocol with evidence." }, outputCategories: ["protocol_match", "missing_data_notice"] },
        ],
        edges: [
          { id: "e1", from: "start", port: "out", to: "patient" },
          { id: "e2", from: "patient", port: "out", to: "hasInd" },
          { id: "e3", from: "hasInd", port: "yes", to: "proto" },
          { id: "e4", from: "hasInd", port: "no", to: "ask" },
          { id: "e5", from: "proto", port: "out", to: "final" },
          { id: "e6", from: "ask", port: "out", to: "final" },
        ],
      },
    };
    expect((await call("author", "PUT", `/agents/${agentId}/draft`, draft)).json()).toEqual({ version: 2 });
    const stale = await call("author", "PUT", `/agents/${agentId}/draft`, draft); // still version 1
    expect([stale.statusCode, stale.json().error]).toEqual([409, "stale_draft"]);

    const compiled = (await call("author", "POST", `/agents/${agentId}/compile`)).json();
    expect(compiled.issues).toEqual([]);
    expect(compiled.manifest.sourceBindings).toEqual([proto]);

    const cand = await call("author", "POST", `/agents/${agentId}/candidates`);
    expect(cand.statusCode).toBe(201);
    expect(cand.json().manifestHash).toBe(compiled.manifestHash);
    await expect(
      withTenant(db, TENANT_A, (tx) => new sql.Request(tx).input("id", cand.json().id).query("UPDATE studio.agent_candidates SET manifest_hash = N'x' WHERE id = @id")),
    ).rejects.toThrow(/immutable/);

    // Withdrawing the knowledge makes the next compile fail (approved sources only).
    await call("approver", "POST", `/knowledge/revisions/${proto}/withdraw`, { reason: "test" });
    const after = (await call("author", "POST", `/agents/${agentId}/compile`)).json();
    expect(after.issues.map((i: { code: string }) => i.code)).toEqual(["knowledge_not_approved"]);
    expect((await call("other", "GET", `/agents/${agentId}`)).statusCode).toBe(404);
  });

  it("voice: clinic profile needs independent approval before the agent compiles", async () => {
    const profile = (await call("author", "POST", "/clinic-profiles", { name: `CT outpatient ${run}`, site: "DEMO", department: "Radiology", risProcedureCode: "CT-ABD", horizonDays: 30, questions: [{ id: "q1", text: "Are you pregnant?", answerType: "yes_no", contraindicationIf: true }] })).json();
    expect(profile.status).toBe("draft");
    expect((await call("author", "POST", `/clinic-profiles/${profile.id}/approve`)).statusCode).toBe(403);
    const agentId = (await call("author", "POST", "/agents", { kind: "voice", name: `CT scheduling ${run}`, intendedUse: "Book CT appointments for verified patients" })).json().id;
    const graph = {
      nodes: [
        { id: "start", type: "start", label: "Incoming call" },
        { id: "auth", type: "verify_authority", label: "Verify caller" },
        { id: "order", type: "resolve_order", label: "Find order" },
        { id: "profile", type: "clinic_profile", label: "CT clinic", clinicProfileId: profile.id },
        { id: "slots", type: "offer_slots", label: "Offer slots" },
        { id: "confirm", type: "confirmation", label: "Read back" },
        { id: "book", type: "book", label: "Book" },
        { id: "staff", type: "transfer_staff", label: "Staff" },
      ],
      edges: [
        { id: "v1", from: "start", port: "out", to: "auth" },
        { id: "v2", from: "auth", port: "out", to: "order" },
        { id: "v3", from: "order", port: "out", to: "profile" },
        { id: "v4", from: "profile", port: "out", to: "slots" },
        { id: "v5", from: "slots", port: "out", to: "confirm" },
        { id: "v6", from: "confirm", port: "yes", to: "book" },
        { id: "v7", from: "confirm", port: "no", to: "staff" },
      ],
    };
    await call("author", "PUT", `/agents/${agentId}/draft`, { version: 1, graph, agentPrompt: { draftText: "Schedule CT for verified callers." }, prohibitions: { optional: [], custom: [] } });
    expect((await call("author", "POST", `/agents/${agentId}/compile`)).json().issues.map((i: { code: string }) => i.code)).toEqual(["profile_not_approved"]);
    expect((await call("approver", "POST", `/clinic-profiles/${profile.id}/approve`)).json().status).toBe("approved");
    const ok = (await call("author", "POST", `/agents/${agentId}/compile`)).json();
    expect(ok.ok).toBe(true);
    expect(ok.manifest.outputPolicy).toBe("confirmed_booking_only");
  });
});
