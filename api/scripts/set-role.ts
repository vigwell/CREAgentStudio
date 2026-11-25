/**
 * npm run set-role -- <email> <role> [--inactive|--active]
 *
 * Sets a Studio user's role (admin, author, approver, viewer), until the Studio
 * has a users screen. The user must have signed in once (that creates the row).
 * Without a role it lists the users. Every change is written to the audit log.
 */
import { loadConfig } from "../src/config.js";
import { createPool, sql } from "../src/db/pool.js";
import { withSystem } from "../src/db/tenant.js";
import { writeAudit } from "../src/services/audit.js";

const ROLES = ["admin", "author", "approver", "viewer"] as const;
const [email, role, flag] = process.argv.slice(2);

const db = await createPool(loadConfig());
try {
  if (!email || !role) {
    const r = await withSystem(db, (tx) =>
      new sql.Request(tx).query<{ email: string; display_name: string; role: string; is_active: boolean }>(
        "SELECT email, display_name, role, is_active FROM studio.users ORDER BY email",
      ),
    );
    console.log("Usage: npm run set-role -- <email> <admin|author|approver|viewer> [--inactive|--active]\n");
    for (const u of r.recordset) console.log(`${u.email ?? "(no email)"}  ${u.role}${u.is_active ? "" : " (inactive)"}  ${u.display_name ?? ""}`);
  } else {
    if (!(ROLES as readonly string[]).includes(role)) throw new Error(`Role must be one of: ${ROLES.join(", ")}`);
    const active = flag === "--inactive" ? false : flag === "--active" ? true : null;
    const changed = await withSystem(db, async (tx) => {
      const r = await new sql.Request(tx)
        .input("email", sql.NVarChar(320), email.trim())
        .input("role", sql.NVarChar(20), role)
        .input("active", sql.Bit, active)
        .query<{ id: string; tenant_id: string; old_role: string }>(
          `UPDATE studio.users SET role = @role, is_active = COALESCE(@active, is_active)
           OUTPUT inserted.id, inserted.tenant_id, deleted.role AS old_role
           WHERE LOWER(email) = LOWER(@email)`,
        );
      for (const u of r.recordset) {
        await writeAudit(tx, {
          tenantId: u.tenant_id,
          userId: null,
          action: "user.role_set",
          entityType: "user",
          entityId: u.id,
          details: { from: u.old_role, to: role, ...(active === null ? {} : { active }), by: "set-role script" },
        });
      }
      return r.recordset;
    });
    if (!changed.length) throw new Error(`No Studio user with email ${email}. They must sign in once first.`);
    for (const u of changed) console.log(`${email}: ${u.old_role} → ${role}${active === null ? "" : active ? " (active)" : " (inactive)"}`);
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.close();
}
