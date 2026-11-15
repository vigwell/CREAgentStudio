/**
 * Runs against the real database when DB_* settings are present (npm test with ../.env).
 * Uses two fixed test tenants; test users are removed afterwards. Audit rows are append-only
 * and stay (they belong to the test tenants only).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import sql from "mssql";
import { loadConfig } from "../src/config.js";
import { createPool, type Db } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { withSystem, withTenant } from "../src/db/tenant.js";
import { resolveUser } from "../src/services/users.js";
import { buildApp } from "../src/app.js";

const hasDb = Boolean(process.env.DB_SERVER && process.env.DB_PASSWORD);
const TENANT_A = "00000000-0000-0000-0000-00000000a001";
const TENANT_B = "00000000-0000-0000-0000-00000000b002";
const oids: string[] = [];
let db: Db;

describe.skipIf(!hasDb)("database (XCreAgents)", () => {
  beforeAll(async () => {
    db = await createPool(loadConfig());
    await migrate(db, undefined, () => {});
    await withSystem(db, (tx) =>
      new sql.Request(tx).query(`
        IF NOT EXISTS (SELECT 1 FROM studio.tenants WHERE id = '${TENANT_A}')
          INSERT INTO studio.tenants (id, name) VALUES ('${TENANT_A}', N'[test] Tenant A');
        IF NOT EXISTS (SELECT 1 FROM studio.tenants WHERE id = '${TENANT_B}')
          INSERT INTO studio.tenants (id, name) VALUES ('${TENANT_B}', N'[test] Tenant B');`),
    );
  });

  afterAll(async () => {
    if (!db) return;
    if (oids.length) {
      await withSystem(db, async (tx) => {
        for (const oid of oids)
          await new sql.Request(tx).input("oid", oid).query("DELETE FROM studio.users WHERE cre_oid = @oid");
      });
    }
    await db.close();
  });

  const identity = () => {
    const oid = `test-${randomUUID()}`;
    oids.push(oid);
    return { oid, email: `${oid}@example.test`, name: "Test User" };
  };

  it("migrations are idempotent", async () => {
    expect(await migrate(db, undefined, () => {})).toBe(0);
  });

  it("provisions a first-time user only when a provisioning tenant is set", async () => {
    const id = identity();
    expect(await resolveUser(db, id)).toBeNull();
    const user = await resolveUser(db, id, TENANT_A);
    expect(user?.tenantId).toBe(TENANT_A);
    // Same person again: found, not duplicated.
    expect((await resolveUser(db, id))?.id).toBe(user?.id);
  });

  it("a tenant sees only its own users", async () => {
    const a = await resolveUser(db, identity(), TENANT_A);
    const b = await resolveUser(db, identity(), TENANT_B);
    const seenByA = await withTenant(db, TENANT_A, async (tx) =>
      (await new sql.Request(tx).query("SELECT id, tenant_id FROM studio.users")).recordset,
    );
    const ids = seenByA.map((r: { id: string }) => r.id.toLowerCase());
    expect(ids).toContain(a!.id);
    expect(ids).not.toContain(b!.id);
    expect(seenByA.every((r: { tenant_id: string }) => r.tenant_id.toLowerCase() === TENANT_A)).toBe(true);
  });

  it("a tenant cannot write rows for another tenant", async () => {
    const oid = identity().oid;
    await expect(
      withTenant(db, TENANT_A, (tx) =>
        new sql.Request(tx)
          .input("oid", oid)
          .query(`INSERT INTO studio.users (tenant_id, cre_oid) VALUES ('${TENANT_B}', @oid)`),
      ),
    ).rejects.toThrow(/block predicate/i);
  });

  it("without a tenant nothing is visible", async () => {
    const r = await db.request().query("SELECT COUNT(*) AS n FROM studio.users");
    expect(r.recordset[0].n).toBe(0);
  });

  it("a failed unit of work does not leave its tenant on a pooled connection", async () => {
    await expect(
      withTenant(db, TENANT_A, (tx) => new sql.Request(tx).query("SELECT 1/0")),
    ).rejects.toThrow();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        db.request().query("SELECT CAST(SESSION_CONTEXT(N'tenant_id') AS NVARCHAR(36)) AS t, CAST(SESSION_CONTEXT(N'system') AS INT) AS s"),
      ),
    );
    for (const r of results) expect(r.recordset[0]).toEqual({ t: null, s: null });
  });

  it("the audit log is append-only", async () => {
    await expect(
      withTenant(db, TENANT_A, (tx) => new sql.Request(tx).query("DELETE FROM studio.audit_log")),
    ).rejects.toThrow(/append-only/);
  });

  it("GET /me returns the Studio user for a valid token, 401/403 otherwise", async () => {
    const id = identity();
    const app = buildApp({
      db,
      logLevel: "silent",
      verifyToken: async (t) => {
        if (t !== "good") throw new (await import("../src/auth/creToken.js")).AuthError("invalid token");
        return id;
      },
    });
    expect((await app.inject({ url: "/me" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/me", headers: { authorization: "Bearer bad" } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/me", headers: { authorization: "Bearer good" } })).statusCode).toBe(403);
    await resolveUser(db, id, TENANT_A);
    const ok = await app.inject({ url: "/me", headers: { authorization: "Bearer good" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user.tenantId).toBe(TENANT_A);
    expect((await app.inject({ url: "/health" })).json()).toEqual({ status: "ok" });
    await app.close();
  });
});
