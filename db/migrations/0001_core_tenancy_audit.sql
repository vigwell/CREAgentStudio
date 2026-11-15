-- 0001: shared core - tenants, users, audit log, tenant isolation (row-level security).
-- Batches are separated by GO lines (handled by the migration runner).

CREATE SCHEMA studio;
GO
CREATE SCHEMA security;
GO

CREATE TABLE studio.tenants (
  id            UNIQUEIDENTIFIER NOT NULL CONSTRAINT df_tenants_id DEFAULT NEWSEQUENTIALID(),
  name          NVARCHAR(200)    NOT NULL,
  cre_org_id    NVARCHAR(100)    NULL,
  created_at    DATETIME2(3)     NOT NULL CONSTRAINT df_tenants_created DEFAULT SYSUTCDATETIME(),
  CONSTRAINT pk_tenants PRIMARY KEY (id)
);
CREATE UNIQUE INDEX ux_tenants_cre_org ON studio.tenants (cre_org_id) WHERE cre_org_id IS NOT NULL;

CREATE TABLE studio.users (
  id            UNIQUEIDENTIFIER NOT NULL CONSTRAINT df_users_id DEFAULT NEWSEQUENTIALID(),
  tenant_id     UNIQUEIDENTIFIER NOT NULL,
  cre_oid       NVARCHAR(64)     NOT NULL,  -- Entra object id ("oid" claim)
  email         NVARCHAR(320)    NULL,
  display_name  NVARCHAR(200)    NULL,
  role          NVARCHAR(20)     NOT NULL CONSTRAINT df_users_role DEFAULT N'viewer',
  is_active     BIT              NOT NULL CONSTRAINT df_users_active DEFAULT 1,
  created_at    DATETIME2(3)     NOT NULL CONSTRAINT df_users_created DEFAULT SYSUTCDATETIME(),
  last_login_at DATETIME2(3)     NULL,
  CONSTRAINT pk_users PRIMARY KEY (id),
  CONSTRAINT fk_users_tenant FOREIGN KEY (tenant_id) REFERENCES studio.tenants (id),
  CONSTRAINT ck_users_role CHECK (role IN (N'admin', N'author', N'approver', N'viewer'))
);
-- One Studio user per CRE identity (a person belongs to one tenant).
CREATE UNIQUE INDEX ux_users_cre_oid ON studio.users (cre_oid);
CREATE INDEX ix_users_tenant ON studio.users (tenant_id);

CREATE TABLE studio.audit_log (
  id            BIGINT IDENTITY(1,1) NOT NULL,
  tenant_id     UNIQUEIDENTIFIER NOT NULL,
  user_id       UNIQUEIDENTIFIER NULL,
  action        NVARCHAR(100)    NOT NULL,
  entity_type   NVARCHAR(100)    NULL,
  entity_id     NVARCHAR(100)    NULL,
  details       NVARCHAR(MAX)    NULL,
  at            DATETIME2(3)     NOT NULL CONSTRAINT df_audit_at DEFAULT SYSUTCDATETIME(),
  CONSTRAINT pk_audit_log PRIMARY KEY (id),
  CONSTRAINT fk_audit_tenant FOREIGN KEY (tenant_id) REFERENCES studio.tenants (id),
  CONSTRAINT ck_audit_details_json CHECK (details IS NULL OR ISJSON(details) = 1)
);
CREATE INDEX ix_audit_tenant_at ON studio.audit_log (tenant_id, at DESC);
GO

-- The audit log is append-only.
CREATE TRIGGER studio.tr_audit_log_append_only
ON studio.audit_log
INSTEAD OF UPDATE, DELETE
AS
BEGIN
  SET NOCOUNT ON;
  THROW 51000, 'audit_log is append-only', 1;
END;
GO

-- Tenant isolation. The API sets SESSION_CONTEXT('tenant_id') for each unit of work.
-- SESSION_CONTEXT('system') = 1 is used only by internal code paths (sign-in lookup, admin tools).
CREATE FUNCTION security.fn_tenant_access (@tenant_id UNIQUEIDENTIFIER)
RETURNS TABLE
WITH SCHEMABINDING
AS
RETURN
  SELECT 1 AS allowed
  WHERE @tenant_id = CAST(SESSION_CONTEXT(N'tenant_id') AS UNIQUEIDENTIFIER)
     OR CAST(SESSION_CONTEXT(N'system') AS INT) = 1;
GO

CREATE SECURITY POLICY security.tenant_isolation
  ADD FILTER PREDICATE security.fn_tenant_access(id)        ON studio.tenants,
  ADD BLOCK  PREDICATE security.fn_tenant_access(id)        ON studio.tenants AFTER INSERT,
  ADD FILTER PREDICATE security.fn_tenant_access(tenant_id) ON studio.users,
  ADD BLOCK  PREDICATE security.fn_tenant_access(tenant_id) ON studio.users AFTER INSERT,
  ADD BLOCK  PREDICATE security.fn_tenant_access(tenant_id) ON studio.users AFTER UPDATE,
  ADD FILTER PREDICATE security.fn_tenant_access(tenant_id) ON studio.audit_log,
  ADD BLOCK  PREDICATE security.fn_tenant_access(tenant_id) ON studio.audit_log AFTER INSERT
WITH (STATE = ON);
GO
