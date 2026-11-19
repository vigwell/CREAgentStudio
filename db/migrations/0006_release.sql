-- 0006: release lifecycle (spec rev 7 §11, §20): saved test cases, test runs
-- against an immutable candidate, independent approval, one active version per
-- agent (rollback = activate an earlier approved version), withdrawal.
-- Draft -> candidate -> tests passed -> approved -> active -> retired / withdrawn.
CREATE TABLE studio.agent_test_cases (
  id              UNIQUEIDENTIFIER NOT NULL CONSTRAINT df_tc_id DEFAULT NEWSEQUENTIALID(),
  tenant_id       UNIQUEIDENTIFIER NOT NULL,
  agent_id        UNIQUEIDENTIFIER NOT NULL,
  name            NVARCHAR(200)    NOT NULL,
  inputs          NVARCHAR(MAX)    NOT NULL,  -- { manualValues, deviceId }
  expected        NVARCHAR(MAX)    NOT NULL,  -- { outcome, findingCodes, path }
  version         INT              NOT NULL CONSTRAINT df_tc_version DEFAULT 1,
  created_by      UNIQUEIDENTIFIER NOT NULL,
  updated_by      UNIQUEIDENTIFIER NOT NULL,
  updated_at      DATETIME2(3)     NOT NULL CONSTRAINT df_tc_updated DEFAULT SYSUTCDATETIME(),
  deleted_at      DATETIME2(3)     NULL,
  CONSTRAINT pk_agent_test_cases PRIMARY KEY (id),
  CONSTRAINT fk_tc_tenant FOREIGN KEY (tenant_id) REFERENCES studio.tenants (id),
  CONSTRAINT fk_tc_agent FOREIGN KEY (agent_id) REFERENCES studio.agents (id),
  CONSTRAINT ck_tc_inputs_json CHECK (ISJSON(inputs) = 1),
  CONSTRAINT ck_tc_expected_json CHECK (ISJSON(expected) = 1)
);
CREATE INDEX ix_tc_agent ON studio.agent_test_cases (agent_id);

CREATE TABLE studio.candidate_test_runs (
  id              UNIQUEIDENTIFIER NOT NULL CONSTRAINT df_ctr_id DEFAULT NEWSEQUENTIALID(),
  tenant_id       UNIQUEIDENTIFIER NOT NULL,
  candidate_id    UNIQUEIDENTIFIER NOT NULL,
  manifest_hash   NVARCHAR(80)     NOT NULL,
  passed          BIT              NOT NULL,
  case_count      INT              NOT NULL,
  failed_count    INT              NOT NULL,
  results         NVARCHAR(MAX)    NOT NULL,
  run_by          UNIQUEIDENTIFIER NOT NULL,
  created_at      DATETIME2(3)     NOT NULL CONSTRAINT df_ctr_created DEFAULT SYSUTCDATETIME(),
  CONSTRAINT pk_candidate_test_runs PRIMARY KEY (id),
  CONSTRAINT fk_ctr_tenant FOREIGN KEY (tenant_id) REFERENCES studio.tenants (id),
  CONSTRAINT fk_ctr_candidate FOREIGN KEY (candidate_id) REFERENCES studio.agent_candidates (id),
  CONSTRAINT ck_ctr_results_json CHECK (ISJSON(results) = 1)
);
CREATE INDEX ix_ctr_candidate ON studio.candidate_test_runs (candidate_id, created_at DESC);
GO
ALTER TABLE studio.agent_candidates DROP CONSTRAINT ck_ac_status;
ALTER TABLE studio.agent_candidates ADD
  test_run_id   UNIQUEIDENTIFIER NULL,
  approved_by   UNIQUEIDENTIFIER NULL,
  approved_at   DATETIME2(3)     NULL,
  activated_by  UNIQUEIDENTIFIER NULL,
  activated_at  DATETIME2(3)     NULL,
  status_reason NVARCHAR(500)    NULL;
GO
ALTER TABLE studio.agent_candidates ADD
  CONSTRAINT ck_ac_status CHECK (status IN (N'candidate', N'approved', N'active', N'retired', N'withdrawn')),
  CONSTRAINT ck_ac_independent CHECK (approved_by IS NULL OR approved_by <> created_by),
  CONSTRAINT fk_ac_test_run FOREIGN KEY (test_run_id) REFERENCES studio.candidate_test_runs (id);
CREATE UNIQUE INDEX ux_ac_one_active ON studio.agent_candidates (agent_id) WHERE status = N'active';
GO
CREATE TRIGGER studio.tr_candidate_test_runs_immutable ON studio.candidate_test_runs AFTER UPDATE, DELETE
AS BEGIN SET NOCOUNT ON; THROW 51005, 'a test run is immutable', 1; END;
GO
ALTER SECURITY POLICY security.tenant_isolation
  ADD FILTER PREDICATE security.fn_tenant_access(tenant_id) ON studio.agent_test_cases,
  ADD BLOCK  PREDICATE security.fn_tenant_access(tenant_id) ON studio.agent_test_cases AFTER INSERT,
  ADD BLOCK  PREDICATE security.fn_tenant_access(tenant_id) ON studio.agent_test_cases AFTER UPDATE,
  ADD FILTER PREDICATE security.fn_tenant_access(tenant_id) ON studio.candidate_test_runs,
  ADD BLOCK  PREDICATE security.fn_tenant_access(tenant_id) ON studio.candidate_test_runs AFTER INSERT,
  ADD BLOCK  PREDICATE security.fn_tenant_access(tenant_id) ON studio.agent_candidates AFTER UPDATE;
GO
