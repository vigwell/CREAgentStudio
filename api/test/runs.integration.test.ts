/**
 * CDS runs over HTTP against XCreAgents: a frozen candidate runs on a manual
 * input snapshot with evidence from the approved rows; idempotent start;
 * reviews bound to the snapshot; tenant isolation.
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
  author: { oid: `rn-author-${run}`, tenant: TENANT_A, role: "author" },
  approver: { oid: `rn-approver-${run}`, tenant: TENANT_A, role: "approver" },
  other: { oid: `rn-other-${run}`, tenant: TENANT_B, role: "admin" },
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
  const sourceId = (await call("author", "POST", "/knowledge/sources", { kind: "device_protocol", name: `Run test protocols ${run}` })).json().id;
  const rev = (await call("author", "POST", `/knowledge/sources/${sourceId}/revisions`, { fileId, sheet: "CT 01", headerRow: 1, mapping: { Protocol: "protocolCode", "Indication code": "conditionCode" }, clinicalOwner: "Dr", reviewDue: "2099-01-01" })).json();
  await call("author", "POST", `/knowledge/revisions/${rev.id}/submit`);
  await call("approver", "POST", `/knowledge/revisions/${rev.id}/approve`);
  return rev.id;
}

describe.skipIf(!hasDb)("CDS runs (XCreAgents)", { timeout: 240_000 }, () => {
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

  it("runs a candidate, replays by key, records reviews against the snapshot", async () => {
    const proto = await approvedProtocolRevision();
    const agentId = (await call("author", "POST", "/agents", { kind: "cds", name: `Run test ${run}`, intendedUse: "Protocol check for review" })).json().id;
    const draft = {
      version: 1,
      agentPrompt: { draftText: "Check CT referrals against the local protocol." },
      prohibitions: { optional: [], custom: [] },
      graph: {
        nodes: [
          { id: "start", type: "start", label: "Referral" },
          { id: "patient", type: "patient_service", label: "Patient data" },
          { id: "proto", type: "protocol_lookup", label: "CT 01 protocol", knowledgeRevisionId: proto },
          { id: "final", type: "final_synthesis", label: "Summary", executionKind: "ai", prompt: { draftText: "Summarize." }, outputCategories: ["protocol_match"] },
        ],
        edges: [
          { id: "e1", from: "start", port: "out", to: "patient" },
          { id: "e2", from: "patient", port: "out", to: "proto" },
          { id: "e3", from: "proto", port: "out", to: "final" },
        ],
      },
    };
    await call("author", "PUT", `/agents/${agentId}/draft`, draft);
    const candidateId = (await call("author", "POST", `/agents/${agentId}/candidates`)).json().id;
    const req = { agentId, candidateId, caseRef: "case-104", inputs: { manualValues: { indicationCode: "DEMO-STROKE", ageYears: 54 } } };

    expect((await call("author", "POST", "/runs", req)).statusCode).toBe(428);
    const first = await call("author", "POST", "/runs", req, { "idempotency-key": `k-${run}` });
    expect(first.statusCode).toBe(201);
    const r = first.json();
    expect([r.state, r.outcome]).toEqual(["completed", "findings"]);
    expect(r.findings[0]).toMatchObject({ code: "PROTOCOL_MATCH_REVIEW", evidence: [{ knowledgeRevisionId: proto, rowId: expect.any(String), sourceRow: 2 }] });
    expect(r.findings[0].observedInputs[0]).toMatchObject({ field: "indicationCode", value: "DEMO-STROKE", attribution: expect.stringMatching(/^manual:/) });
    expect(r.snapshot.facts.egfr).toEqual({ status: "missing" });

    const again = await call("author", "POST", "/runs", req, { "idempotency-key": `k-${run}` });
    expect([again.statusCode, again.json().runId]).toEqual([200, r.runId]);
    const clash = await call("author", "POST", "/runs", { ...req, caseRef: "case-105" }, { "idempotency-key": `k-${run}` });
    expect([clash.statusCode, clash.json().error]).toEqual([409, "idempotency_conflict"]);

    const missing = (await call("author", "POST", "/runs", { ...req, inputs: { manualValues: {} } }, { "idempotency-key": `m-${run}` })).json();
    expect([missing.state, missing.outcome, missing.missingInputs]).toEqual(["awaiting_input", "needs_input", ["indicationCode"]]);

    const stale = await call("author", "POST", `/runs/${r.runId}/reviews`, { findingIndex: 0, action: "acknowledge", snapshotHash: "sha256:old" });
    expect([stale.statusCode, stale.json().error]).toEqual([409, "stale_snapshot"]);
    expect((await call("author", "POST", `/runs/${r.runId}/reviews`, { findingIndex: 0, action: "dismiss", snapshotHash: r.snapshotHash })).statusCode).toBe(422);
    expect((await call("author", "POST", `/runs/${r.runId}/reviews`, { findingIndex: 0, action: "acknowledge", snapshotHash: r.snapshotHash })).statusCode).toBe(201);
    const after = (await call("author", "GET", `/runs/${r.runId}`)).json();
    expect(after.reviews.map((x: { action: string }) => x.action)).toEqual(["acknowledge"]);
    expect((await call("author", "GET", `/agents/${agentId}/runs`)).json().runs).toHaveLength(2);

    expect((await call("other", "GET", `/runs/${r.runId}`)).statusCode).toBe(404);
    await expect(
      withTenant(db, TENANT_A, (tx) => new sql.Request(tx).input("id", r.runId).query("UPDATE studio.input_snapshots SET case_ref = N'x' WHERE id = (SELECT snapshot_id FROM studio.agent_runs WHERE id = @id)")),
    ).rejects.toThrow(/immutable/);
  });
});
