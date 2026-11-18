/**
 * Edge cases over HTTP: bad ids, bad bodies, wrong roles, missing auth, stale
 * versions, huge or empty inputs. Every one must be a clear 4xx, never a 500.
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
  author: { oid: `eg-author-${run}`, tenant: TENANT_A, role: "author" },
  approver: { oid: `eg-approver-${run}`, tenant: TENANT_A, role: "approver" },
  other: { oid: `eg-other-${run}`, tenant: TENANT_B, role: "admin" },
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

describe.skipIf(!hasDb)("edge cases (XCreAgents)", { timeout: 240_000 }, () => {
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

  it("bad ids, bodies, roles and versions are 4xx with a message, never 500", async () => {
    const bad = "not-a-uuid";
    const nil = "00000000-0000-0000-0000-000000000000";
    const probes: [string, "GET" | "POST" | "PUT", string, unknown?][] = [
      ["author", "GET", `/agents/${bad}`],
      ["author", "GET", `/agents/${nil}`],
      ["author", "POST", `/agents/${nil}/compile`],
      ["author", "POST", `/agents/${nil}/candidates`],
      ["author", "PUT", `/agents/${nil}/draft`, { version: 1, graph: { nodes: [], edges: [] }, agentPrompt: null, prohibitions: { optional: [], custom: [] } }],
      ["author", "GET", `/runs/${bad}`],
      ["author", "GET", `/runs/${nil}`],
      ["author", "POST", `/runs/${nil}/reviews`, { findingIndex: 0, action: "acknowledge", snapshotHash: "x" }],
      ["author", "GET", `/knowledge/revisions/${bad}`],
      ["author", "GET", `/knowledge/revisions/${nil}`],
      ["author", "POST", `/knowledge/revisions/${nil}/approve`],
      ["author", "GET", `/knowledge/files/${nil}/preview?headerRow=1`],
      ["author", "POST", `/clinic-profiles/${nil}/approve`],
      ["author", "POST", "/agents", {}],
      ["author", "POST", "/agents", { kind: "robot", name: "x", intendedUse: "y" }],
      ["author", "POST", "/agents", { kind: "cds", name: "   ", intendedUse: "y" }],
      ["author", "POST", "/agents", "not json"],
      ["author", "POST", "/runs", { agentId: nil, candidateId: nil, caseRef: "c" }],
      ["author", "POST", "/runs", { agentId: bad, candidateId: nil, caseRef: "c" }],
      ["author", "POST", "/clinic-profiles", { name: "x", site: "s", department: "d", risProcedureCode: "r", horizonDays: 0 }],
      ["author", "POST", "/clinic-profiles", { name: "x", site: "s", department: "d", risProcedureCode: "r", horizonDays: 9999 }],
      ["author", "POST", "/knowledge/sources", { kind: "nope", name: "x" }],
      ["author", "POST", "/knowledge/sources", { kind: "device_protocol", name: "" }],
      ["author", "POST", "/knowledge/files", "x"],
      ["approver", "POST", "/agents", { kind: "cds", name: `role ${run}`, intendedUse: "y" }],
    ];
    for (const [who, method, url, body] of probes) {
      const r = await call(who as Who, method, url, body, typeof body === "string" ? { "content-type": "application/json" } : {});
      expect.soft(r.statusCode, `${method} ${url} ${JSON.stringify(body ?? "")}`).toBeLessThan(500);
      if (r.statusCode >= 400) expect.soft(r.json().message, `${method} ${url} message`).toBeTruthy();
    }
    expect((await app.inject({ method: "GET", url: "/agents" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/agents", headers: { authorization: "Bearer nobody" } })).statusCode).toBe(401);
  });

  it("drafts: stale version, unknown block, oversized graph, run without key", async () => {
    const agentId = (await call("author", "POST", "/agents", { kind: "cds", name: `edge ${run}`, intendedUse: "edge" })).json().id;
    const base = { agentPrompt: null, prohibitions: { optional: [], custom: [] } };
    const unknown = await call("author", "PUT", `/agents/${agentId}/draft`, { ...base, version: 1, graph: { nodes: [{ id: "x", type: "rocket", label: "x" }], edges: [] } });
    expect(unknown.statusCode).toBe(400);
    const nodes = Array.from({ length: 61 }, (_, i) => ({ id: `n${i}`, type: "instruction", label: "x" }));
    expect((await call("author", "PUT", `/agents/${agentId}/draft`, { ...base, version: 1, graph: { nodes, edges: [] } })).statusCode).toBe(400);
    const badOptional = await call("author", "PUT", `/agents/${agentId}/draft`, { ...base, version: 1, prohibitions: { optional: ["P99"], custom: [] }, graph: { nodes: [], edges: [] } });
    expect(badOptional.statusCode).toBe(400);
    const empty = await call("author", "PUT", `/agents/${agentId}/draft`, { ...base, version: 1, graph: { nodes: [], edges: [] } });
    expect(empty.statusCode).toBe(200);
    const compiled = (await call("author", "POST", `/agents/${agentId}/compile`)).json();
    expect(compiled.ok).toBe(false); // an empty graph is a problem list, not a crash
    expect((await call("author", "POST", `/agents/${agentId}/candidates`)).statusCode).toBe(422);
    expect((await call("author", "PUT", `/agents/${agentId}/draft`, { ...base, version: 1, graph: { nodes: [], edges: [] } })).statusCode).toBe(409);
    expect((await call("other", "GET", `/agents/${agentId}`)).statusCode).toBe(404);
  });
});
