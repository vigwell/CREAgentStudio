import sql from "mssql";

export interface AuditEntry {
  tenantId: string;
  userId?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  details?: Record<string, unknown> | null;
}

export async function writeAudit(tx: sql.Transaction, e: AuditEntry) {
  await new sql.Request(tx)
    .input("tenant", sql.UniqueIdentifier, e.tenantId)
    .input("user", sql.UniqueIdentifier, e.userId ?? null)
    .input("action", sql.NVarChar(100), e.action)
    .input("etype", sql.NVarChar(100), e.entityType ?? null)
    .input("eid", sql.NVarChar(100), e.entityId ?? null)
    .input("details", sql.NVarChar(sql.MAX), e.details ? JSON.stringify(e.details) : null)
    .query(
      `INSERT INTO studio.audit_log (tenant_id, user_id, action, entity_type, entity_id, details)
       VALUES (@tenant, @user, @action, @etype, @eid, @details)`,
    );
}
