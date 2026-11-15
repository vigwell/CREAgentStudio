import sql from "mssql";
import type { Db } from "./pool.js";

/**
 * Run a unit of work inside one transaction with the tenant set in SESSION_CONTEXT,
 * so row-level security only shows and accepts that tenant's rows.
 * The context is cleared before the connection goes back to the pool.
 */
export async function withTenant<T>(
  db: Db,
  tenantId: string,
  work: (tx: sql.Transaction) => Promise<T>,
): Promise<T> {
  return runWithContext(db, { tenant_id: tenantId, system: null }, work);
}

/** Internal code paths only (sign-in lookup, admin tools): sees all tenants. */
export async function withSystem<T>(
  db: Db,
  work: (tx: sql.Transaction) => Promise<T>,
): Promise<T> {
  return runWithContext(db, { tenant_id: null, system: 1 }, work);
}

async function setContext(
  tx: sql.Transaction,
  ctx: { tenant_id: string | null; system: number | null },
) {
  await new sql.Request(tx)
    .input("tenant", sql.NVarChar(36), ctx.tenant_id)
    .input("system", sql.Int, ctx.system)
    .query(
      "EXEC sp_set_session_context N'tenant_id', @tenant; EXEC sp_set_session_context N'system', @system;",
    );
}

async function runWithContext<T>(
  db: Db,
  ctx: { tenant_id: string | null; system: number | null },
  work: (tx: sql.Transaction) => Promise<T>,
): Promise<T> {
  const tx = new sql.Transaction(db);
  await tx.begin();
  try {
    await setContext(tx, ctx);
    const result = await work(tx);
    await setContext(tx, { tenant_id: null, system: null });
    await tx.commit();
    return result;
  } catch (err) {
    // SESSION_CONTEXT is not transactional: clear it on the same connection before it goes
    // back to the pool, or the next user of that connection would inherit this tenant.
    try {
      await setContext(tx, { tenant_id: null, system: null });
    } catch {
      /* transaction already aborted by the server; handled below */
    }
    try {
      await tx.rollback();
    } catch {
      /* already rolled back */
    }
    throw err;
  }
}

export function request(tx: sql.Transaction) {
  return new sql.Request(tx);
}
