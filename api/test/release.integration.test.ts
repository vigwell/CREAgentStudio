/**
 * Release lifecycle over HTTP against XCreAgents: test cases, tests on the
 * frozen candidate, independent approval, activation, clinical runs on the
 * active version, rollback, withdrawal and eligibility checks.
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
  author: { oid: `rl-author-${run}`, tenant: TENANT_A, role: "author" },
  approver: { oid: `rl-approver-${run}`, tenant: TENANT_A, role: "approver" },
  other: { oid: `rl-other-${run}`, tenant: TENANT_B, role: "admin" },
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
  const sourceId = (await call("author", "POST", "/knowledge/sources", { kind: "device_protocol", name: `Release test protocols ${run}` })).json().id;
  const rev = (await call("author", "POST", `/knowledge/sources/${sourceId}/revisions`, { fileId, sheet: "CT 01", headerRow: 1, mapping: { Protocol: "protocolCode", "Indication code": "conditionCode" }, clinicalOwner: "Dr", reviewDue: "2099-01-01" })).json();
  await call("author", "POST", `/knowledge/revisions/${rev.id}/submit`);
  await call("approver", "POST", `/knowledge/revisions/${rev.id}/approve`);
  return rev.id;
}

describe.skipIf(!hasDb)("release lifecycle (XCreAgents)", { timeout: 240_000 }, () => {
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

  it("draft → candidate → tests → independent approval → active → rollback → withdraw", async () => {
    const proto = await approvedProtocolRevision();
    const agentId = (await call("author", "POST", "/agents", { kind: "cds", name: `Release ${run}`, intendedUse: "Protocol check" })).json().id;
    const graph = (label: string) => ({
      nodes: [
        { id: "start", type: "start", label: "Referral" },
        { id: "patient", type: "patient_service", label: "Patient data" },
        { id: "proto", type: "protocol_lookup", label, knowledgeRevisionId: proto },
        { id: "final", type: "final_synthesis", label: "Summary", executionKind: "ai", prompt: { draftText: "Summarize." }, outputCategories: ["protocol_match"] },
      ],
      edges: [
        { id: "e1", from: "start", port: "out", to: "patient" },
        { id: "e2", from: "patient", port: "out", to: "proto" },
        { id: "e3", from: "proto", port: "out", to: "final" },
      ],
    });
    const draft = (version: number, label: string) => ({ version, agentPrompt: { draftText: "Check CT referrals." }, prohibitions: { optional: [], custom: [] }, graph: graph(label) });
    await call("author", "PUT", `/agents/${agentId}/draft`, draft(1, "CT 01"));
    const c1 = (await call("author", "POST", `/agents/${agentId}/candidates`)).json().id;

    // No test cases yet: can't test, can't approve.
    expect((await call("author", "POST", `/candidates/${c1}/tests`)).json().error).toBe("no_test_cases");
    expect((await call("approver", "POST", `/candidates/${c1}/approve`)).json().error).toBe("tests_required");

    const ok = await call("author", "POST", `/agents/${agentId}/test-cases`, {
      name: "Stroke matches CT-HEAD-01",
      inputs: { manualValues: { indicationCode: "DEMO-STROKE" } },
      expected: { outcome: "findings", findingCodes: ["PROTOCOL_MATCH_REVIEW"], path: [{ nodeId: "proto", state: "completed" }] },
    });
    expect(ok.statusCode).toBe(201);
    const wrong = (await call("author", "POST", `/agents/${agentId}/test-cases`, {
      name: "Missing indication asks for input",
      inputs: { manualValues: {} },
      expected: { outcome: "findings" }, // wrong on purpose
    })).json();
    const t1 = (await call("author", "POST", `/candidates/${c1}/tests`)).json();
    expect([t1.passed, t1.caseCount, t1.failedCount]).toEqual([false, 2, 1]);
    expect(t1.results.find((r: { name: string }) => r.name.startsWith("Missing")).problems[0]).toMatchObject({ kind: "outcome", expected: "findings", actual: "needs_input" });
    expect((await call("approver", "POST", `/candidates/${c1}/approve`)).json().error).toBe("tests_required");

    // Fix the case; the old run no longer covers the suite.
    const fixed = await call("author", "PUT", `/agents/${agentId}/test-cases/${wrong.id}`, { ...wrong, expected: { outcome: "needs_input" }, version: wrong.version });
    expect(fixed.statusCode).toBe(200);
    expect((await call("author", "PUT", `/agents/${agentId}/test-cases/${wrong.id}`, { ...wrong, version: wrong.version })).json().error).toBe("stale_test_case");
    expect((await call("approver", "POST", `/candidates/${c1}/approve`)).json().error).toBe("tests_required");
    expect((await call("author", "POST", `/candidates/${c1}/tests`)).json().passed).toBe(true);

    // The author can't approve; another approver can.
    expect((await call("author", "POST", `/candidates/${c1}/approve`)).statusCode).toBe(403);
    expect((await call("approver", "POST", `/candidates/${c1}/approve`)).json().status).toBe("approved");

    // No active version yet: a clinical run (no candidate) is refused.
    const clinicalReq = { agentId, caseRef: "case-1", inputs: { manualValues: { indicationCode: "DEMO-STROKE" } } };
    expect((await call("author", "POST", "/runs", clinicalReq, { "idempotency-key": `c0-${run}` })).json().error).toBe("no_active_version");
    expect((await call("author", "POST", `/candidates/${c1}/activate`)).statusCode).toBe(403);
    expect((await call("approver", "POST", `/candidates/${c1}/activate`)).json().status).toBe("active");
    const clinical = (await call("author", "POST", "/runs", clinicalReq, { "idempotency-key": `c1-${run}` })).json();
    expect([clinical.outcome, clinical.purpose, clinical.candidateNo]).toEqual(["findings", "clinical", 1]);

    // Version 2: diff against the active one, tests, approval, activation retires v1.
    await call("author", "PUT", `/agents/${agentId}/draft`, draft(2, "CT 01 (v2)"));
    const c2 = (await call("author", "POST", `/agents/${agentId}/candidates`)).json().id;
    const diff = (await call("approver", "GET", `/candidates/${c2}/diff`)).json();
    expect(diff.against.candidateNo).toBe(1);
    expect(diff.changed).toContain("block CT 01 (v2)");
    await call("author", "POST", `/candidates/${c2}/tests`);
    await call("approver", "POST", `/candidates/${c2}/approve`);
    expect((await call("approver", "POST", `/candidates/${c2}/activate`)).json().previous).toBe(c1);
    let versions = (await call("author", "GET", `/agents/${agentId}/versions`)).json().versions;
    expect(versions.map((v: { candidateNo: number; status: string }) => `${v.candidateNo}:${v.status}`)).toEqual(["2:active", "1:retired"]);

    // Rollback: v1 again.
    await call("approver", "POST", `/candidates/${c1}/activate`);
    versions = (await call("author", "GET", `/agents/${agentId}/versions`)).json().versions;
    expect(versions.map((v: { candidateNo: number; status: string }) => `${v.candidateNo}:${v.status}`)).toEqual(["2:retired", "1:active"]);

    // A withdrawn source makes every version ineligible.
    await call("approver", "POST", `/knowledge/revisions/${proto}/withdraw`, { reason: "test" });
    expect((await call("approver", "POST", `/candidates/${c2}/activate`)).json().error).toBe("not_eligible");

    // Withdraw the active version: no active version, clinical runs stop.
    expect((await call("approver", "POST", `/candidates/${c1}/withdraw`, {})).statusCode).toBe(422);
    expect((await call("approver", "POST", `/candidates/${c1}/withdraw`, { reason: "Source withdrawn" })).json().status).toBe("withdrawn");
    expect((await call("author", "POST", "/runs", { ...clinicalReq, caseRef: "case-2" }, { "idempotency-key": `c2-${run}` })).json().error).toBe("no_active_version");
    expect((await call("approver", "POST", `/candidates/${c1}/activate`)).json().error).toBe("bad_state");

    // Run Inspector lists the clinical run; other tenants see nothing.
    const listed = (await call("author", "GET", `/runs?agentId=${agentId}&purpose=clinical`)).json().runs;
    expect(listed.map((r: { runId: string }) => r.runId)).toContain(clinical.runId);
    expect((await call("other", "GET", `/agents/${agentId}/versions`)).json().versions).toEqual([]);
    expect((await call("other", "POST", `/candidates/${c2}/approve`)).statusCode).toBe(404);
  });
});
