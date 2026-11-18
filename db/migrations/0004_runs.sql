-- 0004: CDS runs (spec rev 7 §07, §10, §17).
-- Input snapshots (patient data) are stored apart from run metadata; a run
-- points at an immutable candidate and snapshot. Reviews (acknowledge,
-- dismiss, defer) are recorded separately from the clinical finding.
CREATE TABLE studio.input_snapshots (
  id              UNIQUEIDENTIFIER NOT NULL CONSTRAINT df_is_id DEFAULT NEWSEQUENTIALID(),
  tenant_id       UNIQUEIDENTIFIER NOT NULL,
  case_ref        NVARCHAR(200)    NOT NULL,
  content         NVARCHAR(MAX)    NOT NULL,
  content_hash    NVARCHAR(80)     NOT NULL,
  created_by      UNIQUEIDENTIFIER NOT NULL,
  created_at      DATETIME2(3)     NOT NULL CONSTRAINT df_is_created DEFAULT SYSUTCDATETIME(),
  CONSTRAINT pk_input_snapshots PRIMARY KEY (id),
  CONSTRAINT fk_is_tenant FOREIGN KEY (tenant_id) REFERENCES studio.tenants (id),
  CONSTRAINT ck_is_json CHECK (ISJSON(content) = 1)
);
CREATE TABLE studio.agent_runs (
  id               UNIQUEIDENTIFIER NOT NULL CONSTRAINT df_ar_id DEFAULT NEWSEQUENTIALID(),
  tenant_id        UNIQUEIDENTIFIER NOT NULL,
  agent_id         UNIQUEIDENTIFIER NOT NULL,
  candidate_id     UNIQUEIDENTIFIER NOT NULL,
  snapshot_id      UNIQUEIDENTIFIER NOT NULL,
  idempotency_key  NVARCHAR(100)    NOT NULL,
  request_hash     NVARCHAR(80)     NOT NULL,
  case_ref         NVARCHAR(200)    NOT NULL,
  execution_mode   NVARCHAR(40)     NOT NULL,
  purpose          NVARCHAR(20)     NOT NULL,   -- test | clinical
  state            NVARCHAR(20)     NOT NULL,
  outcome          NVARCHAR(20)     NULL,
  result           NVARCHAR(MAX)    NULL,        -- findings, trace, summary
  created_by       UNIQUEIDENTIFIER NOT NULL,
  created_at       DATETIME2(3)     NOT NULL CONSTRAINT df_ar_created DEFAULT SYSUTCDATETIME(),
  finished_at      DATETIME2(3)     NULL,
  CONSTRAINT pk_agent_runs PRIMARY KEY (id),
  CONSTRAINT fk_ar_tenant FOREIGN KEY (tenant_id) REFERENCES studio.tenants (id),
  CONSTRAINT fk_ar_agent FOREIGN KEY (agent_id) REFERENCES studio.agents (id),
  CONSTRAINT fk_ar_candidate FOREIGN KEY (candidate_id) REFERENCES studio.agent_candidates (id),
  CONSTRAINT fk_ar_snapshot FOREIGN KEY (snapshot_id) REFERENCES studio.input_snapshots (id),
  CONSTRAINT ck_ar_state CHECK (state IN (N'queued', N'running', N'awaiting_input', N'completed', N'failed', N'cancelled', N'expired')),
  CONSTRAINT ck_ar_outcome CHECK (outcome IS NULL OR outcome IN (N'findings', N'needs_input', N'needs_review', N'not_applicable', N'blocked', N'unavailable')),
  CONSTRAINT ck_ar_purpose CHECK (purpose IN (N'test', N'clinical')),
  CONSTRAINT ck_ar_result_json CHECK (result IS NULL OR ISJSON(result) = 1)
);
CREATE UNIQUE INDEX ux_ar_idem ON studio.agent_runs (tenant_id, created_by, idempotency_key);
CREATE INDEX ix_ar_agent ON studio.agent_runs (agent_id, created_at DESC);
CREATE TABLE studio.run_reviews (
  id              UNIQUEIDENTIFIER NOT NULL CONSTRAINT df_rr_id DEFAULT NEWSEQUENTIALID(),
  tenant_id       UNIQUEIDENTIFIER NOT NULL,
  run_id          UNIQUEIDENTIFIER NOT NULL,
  finding_index   INT              NOT NULL,
  finding_code    NVARCHAR(60)     NOT NULL,
  action          NVARCHAR(20)     NOT NULL,
  reason          NVARCHAR(1000)   NULL,
  snapshot_hash   NVARCHAR(80)     NOT NULL,
  created_by      UNIQUEIDENTIFIER NOT NULL,
  created_at      DATETIME2(3)     NOT NULL CONSTRAINT df_rr_created DEFAULT SYSUTCDATETIME(),
  CONSTRAINT pk_run_reviews PRIMARY KEY (id),
  CONSTRAINT fk_rr_tenant FOREIGN KEY (tenant_id) REFERENCES studio.tenants (id),
  CONSTRAINT fk_rr_run FOREIGN KEY (run_id) REFERENCES studio.agent_runs (id),
  CONSTRAINT ck_rr_action CHECK (action IN (N'acknowledge', N'dismiss', N'defer'))
);
GO
-- Snapshots and reviews are append-only.
CREATE TRIGGER studio.tr_input_snapshots_immutable ON studio.input_snapshots AFTER UPDATE, DELETE
AS BEGIN SET NOCOUNT ON; THROW 51003, 'an input snapshot is immutable', 1; END;
GO
CREATE TRIGGER studio.tr_run_reviews_immutable ON studio.run_reviews AFTER UPDATE, DELETE
AS BEGIN SET NOCOUNT ON; THROW 51004, 'a run review is immutable', 1; END;
GO
ALTER SECURITY POLICY security.tenant_isolation
  ADD FILTER PREDICATE security.fn_tenant_access(tenant_id) ON studio.input_snapshots,
  ADD BLOCK  PREDICATE security.fn_tenant_access(tenant_id) ON studio.input_snapshots AFTER INSERT,
  ADD FILTER PREDICATE security.fn_tenant_access(tenant_id) ON studio.agent_runs,
  ADD BLOCK  PREDICATE security.fn_tenant_access(tenant_id) ON studio.agent_runs AFTER INSERT,
  ADD BLOCK  PREDICATE security.fn_tenant_access(tenant_id) ON studio.agent_runs AFTER UPDATE,
  ADD FILTER PREDICATE security.fn_tenant_access(tenant_id) ON studio.run_reviews,
  ADD BLOCK  PREDICATE security.fn_tenant_access(tenant_id) ON studio.run_reviews AFTER INSERT;
GO
