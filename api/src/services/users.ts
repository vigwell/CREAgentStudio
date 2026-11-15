import sql from "mssql";
import type { Db } from "../db/pool.js";
import { withSystem, withTenant } from "../db/tenant.js";
import type { CreIdentity } from "../auth/creToken.js";
import { writeAudit } from "./audit.js";

export type Role = "admin" | "author" | "approver" | "viewer";

export interface StudioUser {
  id: string;
  tenantId: string;
  email: string | null;
  displayName: string | null;
  role: Role;
}

interface UserRow {
  id: string;
  tenant_id: string;
  email: string | null;
  display_name: string | null;
  role: Role;
  is_active: boolean;
}

const toUser = (r: UserRow): StudioUser => ({
  id: r.id.toLowerCase(),
  tenantId: r.tenant_id.toLowerCase(),
  email: r.email,
  displayName: r.display_name,
  role: r.role,
});

/**
 * Find the Studio user for a CRE identity. In development, a first-time user can be added to
 * AUTO_PROVISION_TENANT_ID (the first user of a tenant becomes its admin). Returns null when
 * the person has no Studio access.
 */
export async function resolveUser(
  db: Db,
  identity: CreIdentity,
  autoProvisionTenantId?: string,
): Promise<StudioUser | null> {
  const existing = await withSystem(db, async (tx) => {
    const r = await new sql.Request(tx)
      .input("oid", sql.NVarChar(64), identity.oid)
      .query<UserRow>(
        "SELECT id, tenant_id, email, display_name, role, is_active FROM studio.users WHERE cre_oid = @oid",
      );
    return r.recordset[0] ?? null;
  });

  if (existing) {
    if (!existing.is_active) return null;
    const user = toUser(existing);
    await withTenant(db, user.tenantId, (tx) =>
      new sql.Request(tx)
        .input("id", sql.UniqueIdentifier, user.id)
        .input("email", sql.NVarChar(320), identity.email)
        .input("name", sql.NVarChar(200), identity.name)
        .query(
          `UPDATE studio.users SET last_login_at = SYSUTCDATETIME(),
             email = COALESCE(@email, email), display_name = COALESCE(@name, display_name)
           WHERE id = @id`,
        ),
    );
    return user;
  }

  if (!autoProvisionTenantId) return null;

  return withTenant(db, autoProvisionTenantId, async (tx) => {
    const count = await new sql.Request(tx).query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM studio.users",
    );
    const role: Role = count.recordset[0].n === 0 ? "admin" : "author";
    const inserted = await new sql.Request(tx)
      .input("tenant", sql.UniqueIdentifier, autoProvisionTenantId)
      .input("oid", sql.NVarChar(64), identity.oid)
      .input("email", sql.NVarChar(320), identity.email)
      .input("name", sql.NVarChar(200), identity.name)
      .input("role", sql.NVarChar(20), role)
      .query<UserRow>(
        `INSERT INTO studio.users (tenant_id, cre_oid, email, display_name, role, last_login_at)
         OUTPUT inserted.id, inserted.tenant_id, inserted.email, inserted.display_name, inserted.role, inserted.is_active
         VALUES (@tenant, @oid, @email, @name, @role, SYSUTCDATETIME())`,
      );
    const user = toUser(inserted.recordset[0]);
    await writeAudit(tx, {
      tenantId: user.tenantId,
      userId: user.id,
      action: "user.provisioned",
      entityType: "user",
      entityId: user.id,
      details: { role, source: "auto_provision" },
    });
    return user;
  });
}
