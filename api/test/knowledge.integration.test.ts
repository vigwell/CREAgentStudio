/**
 * Knowledge Library end to end over HTTP against XCreAgents (needs ../.env):
 * upload → preview → source → revision → submit → independent approval → withdraw,
 * tenant isolation and immutable rows. Uses the fixed test tenants; test users
 * are removed afterwards (knowledge data of the test tenants stays: audit and
 * approved revisions are append-only by design).
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
  author: { oid: `test-author-${run}`, tenant: TENANT_A, role: "author" },
  approver: { oid: `test-approver-${run}`, tenant: TENANT_A, role: "approver" },
  viewer: { oid: `test-viewer-${run}`, tenant: TENANT_A, role: "viewer" },
  other: { oid: `test-other-${run}`, tenant: TENANT_B, role: "admin" },
} as const;
type Who = keyof typeof people;

let db: Db;
let app: ReturnType<typeof buildApp>;

async function xlsx(rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("CT 01");
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function multipart(filename: string, content: Buffer) {
  const boundary = `----test${run}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload: body, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

const call = (who: Who, method: "GET" | "POST", url: string, extra: { payload?: unknown; headers?: Record<string, string> } = {}) =>
  app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${who}`, ...(extra.headers ?? {}) },
    payload: extra.payload as never,
  });

describe.skipIf(!hasDb)("knowledge library (XCreAgents)", { timeout: 240_000 }, () => {
  beforeAll(async () => {
    db = await createPool(loadConfig());
    await migrate(db, undefined, () => {});
    await withSystem(db, async (tx) => {
      await new sql.Request(tx).query(`
        IF NOT EXISTS (SELECT 1 FROM studio.tenants WHERE id = '${TENANT_A}') INSERT INTO studio.tenants (id, name) VALUES ('${TENANT_A}', N'[test] Tenant A');
        IF NOT EXISTS (SELECT 1 FROM studio.tenants WHERE id = '${TENANT_B}') INSERT INTO studio.tenants (id, name) VALUES ('${TENANT_B}', N'[test] Tenant B');`);
      for (const p of Object.values(people)) {
        await new sql.Request(tx)
          .input("t", p.tenant)
          .input("oid", p.oid)
          .input("role", p.role)
          .query("INSERT INTO studio.users (tenant_id, cre_oid, display_name, role) VALUES (@t, @oid, @oid, @role)");
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

  it("full flow: upload, preview, map, submit, independent approval, withdraw", async () => {
    const file = await xlsx([
      ["Local CT protocols"],
      ["Protocol", "Name", "Indication code", "Min age"],
      ["CT-HEAD-01", "Head", "DEMO-STROKE", 18],
      ["CT-CHEST-02", "Chest", "DEMO-PE", 16],
    ]);
    const up = await call("author", "POST", "/knowledge/files", multipart(`protocols-${run}.xlsx`, file));
    expect(up.statusCode).toBe(201);
    const { fileId, sheets, sha256 } = up.json();
    expect(sheets.map((s: { name: string }) => s.name)).toEqual(["CT 01"]);
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);

    const pv = await call("author", "GET", `/knowledge/files/${fileId}/preview?sheet=CT%2001&headerRow=2`);
    expect(pv.statusCode).toBe(200);
    expect(pv.json().headers).toEqual(["Protocol", "Name", "Indication code", "Min age"]);
    expect(pv.json().totalRows).toBe(2);

    const src = await call("author", "POST", "/knowledge/sources", { payload: { kind: "device_protocol", name: `CT 01 protocols ${run}` } });
    expect(src.statusCode).toBe(201);
    const sourceId = src.json().id;

    const rev = await call("author", "POST", `/knowledge/sources/${sourceId}/revisions`, {
      payload: {
        fileId,
        sheet: "CT 01",
        headerRow: 2,
        mapping: { Protocol: "protocolCode", Name: "protocolName", "Indication code": "conditionCode", "Min age": "ageMinYears" },
        scope: { site: "DEMO", modality: "CT", devices: ["CT 01"] },
        clinicalOwner: "Dr Demo",
        reviewDue: "2099-12-31",
      },
    });
    expect(rev.statusCode).toBe(201);
    const r = rev.json();
    expect([r.revisionNo, r.rowCount, r.errorCount, r.status]).toEqual([1, 2, 0, "draft"]);

    const got = await call("viewer", "GET", `/knowledge/revisions/${r.id}`);
    expect(got.statusCode).toBe(200);
    expect(got.json().rows[0].mapped).toEqual({ protocolCode: "CT-HEAD-01", protocolName: "Head", conditionCode: "DEMO-STROKE", ageMinYears: 18 });
    expect(got.json().rows[0].cells.Protocol.ref).toBe("CT 01!A3");

    expect((await call("viewer", "POST", `/knowledge/revisions/${r.id}/submit`)).statusCode).toBe(403);
    expect((await call("author", "POST", `/knowledge/revisions/${r.id}/approve`)).statusCode).toBe(403); // role
    expect((await call("author", "POST", `/knowledge/revisions/${r.id}/submit`)).json().status).toBe("in_review");

    // Rows can't change once submitted (immutable revision).
    await expect(
      withTenant(db, TENANT_A, (tx) => new sql.Request(tx).input("id", r.id).query("DELETE FROM studio.knowledge_rows WHERE revision_id = @id")),
    ).rejects.toThrow(/cannot change/);

    const ok = await call("approver", "POST", `/knowledge/revisions/${r.id}/approve`);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe("approved");
    expect((await call("viewer", "GET", "/knowledge/sources")).json().sources.find((s: { id: string }) => s.id === sourceId).latestRevision.status).toBe("approved");

    expect((await call("approver", "POST", `/knowledge/revisions/${r.id}/withdraw`, { payload: { reason: "test" } })).json().status).toBe("withdrawn");

    const audit = await withTenant(db, TENANT_A, async (tx) =>
      (await new sql.Request(tx).input("id", r.id).query("SELECT action FROM studio.audit_log WHERE entity_id = @id ORDER BY id")).recordset.map((x: { action: string }) => x.action),
    );
    expect(audit).toEqual(["knowledge.revision_created", "knowledge.revision_submitted", "knowledge.revision_approved", "knowledge.revision_withdrawn"]);
  });

  it("the author cannot approve their own revision (even as approver/admin)", async () => {
    const file = await xlsx([["Protocol"], ["CT-X"]]);
    const { fileId } = (await call("approver", "POST", "/knowledge/files", multipart("x.xlsx", file))).json();
    const sourceId = (await call("approver", "POST", "/knowledge/sources", { payload: { kind: "device_protocol", name: `Own ${run}` } })).json().id;
    const rev = (
      await call("approver", "POST", `/knowledge/sources/${sourceId}/revisions`, {
        payload: { fileId, sheet: "CT 01", headerRow: 1, mapping: { Protocol: "protocolCode" }, clinicalOwner: "Dr", reviewDue: "2099-01-01" },
      })
    ).json();
    await call("approver", "POST", `/knowledge/revisions/${rev.id}/submit`);
    const res = await call("approver", "POST", `/knowledge/revisions/${rev.id}/approve`);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("not_independent");
  });

  it("a revision with row errors stays a draft; the next import is revision 2", async () => {
    const file = await xlsx([["Protocol", "Min age"], ["CT-1", "adult"], ["", 30]]);
    const { fileId } = (await call("author", "POST", "/knowledge/files", multipart("bad.xlsx", file))).json();
    const sourceId = (await call("author", "POST", "/knowledge/sources", { payload: { kind: "device_protocol", name: `Errors ${run}` } })).json().id;
    const body = { fileId, sheet: "CT 01", headerRow: 1, mapping: { Protocol: "protocolCode", "Min age": "ageMinYears" }, clinicalOwner: "Dr", reviewDue: "2099-01-01" };
    const rev = (await call("author", "POST", `/knowledge/sources/${sourceId}/revisions`, { payload: body })).json();
    expect(rev.errorCount).toBe(2);
    expect(rev.errors[0].errors[0].ref).toBe("CT 01!B2");
    const sub = await call("author", "POST", `/knowledge/revisions/${rev.id}/submit`);
    expect(sub.statusCode).toBe(422);
    const fixed = await xlsx([["Protocol", "Min age"], ["CT-1", 18], ["CT-2", 30]]);
    const f2 = (await call("author", "POST", "/knowledge/files", multipart("fixed.xlsx", fixed))).json().fileId;
    const rev2 = (await call("author", "POST", `/knowledge/sources/${sourceId}/revisions`, { payload: { ...body, fileId: f2 } })).json();
    expect([rev2.revisionNo, rev2.errorCount]).toEqual([2, 0]);
  });

  it("bad files and bad mappings get clear errors", async () => {
    const xlsm = await call("author", "POST", "/knowledge/files", multipart("m.xlsm", Buffer.from("x")));
    expect(xlsm.statusCode).toBe(415);
    const notZip = await call("author", "POST", "/knowledge/files", multipart("n.xlsx", Buffer.from("not a zip")));
    expect([notZip.statusCode, notZip.json().error]).toEqual([422, "not_xlsx"]);
    const csv = (await call("author", "POST", "/knowledge/files", multipart("r.csv", Buffer.from("Id,Result\nR1,CT\n")))).json();
    const sourceId = (await call("author", "POST", "/knowledge/sources", { payload: { kind: "clinical_rule", name: `Rules ${run}` } })).json().id;
    const res = await call("author", "POST", `/knowledge/sources/${sourceId}/revisions`, {
      payload: { fileId: csv.fileId, headerRow: 1, mapping: { Result: "result" }, clinicalOwner: "Dr", reviewDue: "2099-01-01" },
    });
    expect([res.statusCode, res.json().error]).toEqual([422, "bad_mapping"]);
    expect(res.json().message).toMatch(/conditionCode or indication/);
  });

  it("another tenant sees none of it", async () => {
    const mine = (await call("author", "GET", "/knowledge/sources")).json().sources;
    expect(mine.length).toBeGreaterThan(0);
    const theirs = (await call("other", "GET", "/knowledge/sources")).json().sources;
    expect(theirs.some((s: { name: string }) => s.name.endsWith(run))).toBe(false);
    const someRevision = mine.find((s: { latestRevision: unknown }) => s.latestRevision).latestRevision.id;
    expect((await call("other", "GET", `/knowledge/revisions/${someRevision}`)).statusCode).toBe(404);
  });
});
