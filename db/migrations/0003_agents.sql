-- 0003: agent authoring (spec rev 7 §06, §08, §16-19; rev 9 §27).
-- An agent has one editable draft (graph + prompts + prohibitions, optimistic
-- version) and immutable compiled candidates (manifest + hash). Clinic & exam
-- profiles (voice scheduling) are revisioned and approved independently.

CREATE TABLE studio.agents (
  id              UNIQUEIDENTIFIER NOT NULL CONSTRAINT df_ag_id DEFAULT NEWSEQUENTIALID(),
  tenant_id       UNIQUEIDENTIFIER NOT NULL,
  kind            NVARCHAR(10)     NOT NULL,
  name            NVARCHAR(200)    NOT NULL,
  intended_use    NVARCHAR(2000)   NOT NULL,
  scope           NVARCHAR(MAX)    NOT NULL,
  execution_mode  NVARCHAR(40)     NOT NULL,
  created_by      UNIQUEIDENTIFIER NOT NULL,
  created_at      DATETIME2(3)     NOT NULL CONSTRAINT df_ag_created DEFAULT SYSUTCDATETIME(),
  CONSTRAINT pk_agents PRIMARY KEY (id),
  CONSTRAINT fk_ag_tenant FOREIGN KEY (tenant_id) REFERENCES studio.tenants (id),
  CONSTRAINT ck_ag_kind CHECK (kind IN (N'cds', N'voice')),
  CONSTRAINT ck_ag_scope_json CHECK (ISJSON(scope) = 1)
);
CREATE UNIQUE INDEX ux_ag_tenant_name ON studio.agents (tenant_id, name);

CREATE TABLE studio.agent_drafts (
  agent_id        UNIQUEIDENTIFIER NOT NULL,
  tenant_id       UNIQUEIDENTIFIER NOT NULL,
  graph           NVARCHAR(MAX)    NOT NULL,
  agent_prompt    NVARCHAR(MAX)    NULL,
  prohibitions    NVARCHAR(MAX)    NOT NULL,
  version         INT              NOT NULL CONSTRAINT df_ad_version DEFAULT 1,
  updated_by      UNIQUEIDENTIFIER NOT NULL,
  updated_at      DATETIME2(3)     NOT NULL CONSTRAINT df_ad_updated DEFAULT SYSUTCDATETIME(),
  CONSTRAINT pk_agent_drafts PRIMARY KEY (agent_id),
  CONSTRAINT fk_ad_agent FOREIGN KEY (agent_id) REFERENCES studio.agents (id),
  CONSTRAINT fk_ad_tenant FOREIGN KEY (tenant_id) REFERENCES studio.tenants (id),
  CONSTRAINT ck_ad_graph_json CHECK (ISJSON(graph) = 1),
  CONSTRAINT ck_ad_prompt_json CHECK (agent_prompt IS NULL OR ISJSON(agent_prompt) = 1),
  CONSTRAINT ck_ad_prohib_json CHECK (ISJSON(prohibitions) = 1)
);

CREATE TABLE studio.agent_candidates (
  id              UNIQUEIDENTIFIER NOT NULL CONSTRAINT df_ac_id DEFAULT NEWSEQUENTIALID(),
  tenant_id       UNIQUEIDENTIFIER NOT NULL,
  agent_id        UNIQUEIDENTIFIER NOT NULL,
  candidate_no    INT              NOT NULL,
  manifest        NVARCHAR(MAX)    NOT NULL,
  manifest_hash   NVARCHAR(80)     NOT NULL,
  draft_version   INT              NOT NULL,
  status          NVARCHAR(20)     NOT NULL CONSTRAINT df_ac_status DEFAULT N'candidate',
  created_by      UNIQUEIDENTIFIER NOT NULL,
  created_at      DATETIME2(3)     NOT NULL CONSTRAINT df_ac_created DEFAULT SYSUTCDATETIME(),
  CONSTRAINT pk_agent_candidates PRIMARY KEY (id),
  CONSTRAINT fk_ac_agent FOREIGN KEY (agent_id) REFERENCES studio.agents (id),
  CONSTRAINT fk_ac_tenant FOREIGN KEY (tenant_id) REFERENCES studio.tenants (id),
  CONSTRAINT ck_ac_status CHECK (status IN (N'candidate', N'approved', N'withdrawn')),
  CONSTRAINT ck_ac_manifest_json CHECK (ISJSON(manifest) = 1)
);
CREATE UNIQUE INDEX ux_ac_agent_no ON studio.agent_candidates (agent_id, candidate_no);
GO

-- A candidate's manifest never changes (status may).
CREATE TRIGGER studio.tr_agent_candidates_immutable
ON studio.agent_candidates
AFTER UPDATE
AS
BEGIN
  SET NOCOUNT ON;
  IF UPDATE(manifest) OR UPDATE(manifest_hash) OR UPDATE(agent_id) OR UPDATE(candidate_no)
    THROW 51002, 'a candidate manifest is immutable', 1;
END;
GO

CREATE TABLE studio.clinic_exam_profiles (
  id                       UNIQUEIDENTIFIER NOT NULL CONSTRAINT df_cp_id DEFAULT NEWSEQUENTIALID(),
  tenant_id                UNIQUEIDENTIFIER NOT NULL,
  profile_key              UNIQUEIDENTIFIER NOT NULL,  -- groups the revisions of one profile
  revision_no              INT              NOT NULL,
  name                     NVARCHAR(200)    NOT NULL,
  site                     NVARCHAR(100)    NOT NULL,
  department               NVARCHAR(100)    NOT NULL,
  subdepartment            NVARCHAR(100)    NULL,
  ris_procedure_code       NVARCHAR(50)     NOT NULL,
  protocol_revision_id     UNIQUEIDENTIFIER NULL,
  protocol_code            NVARCHAR(100)    NULL,
  questions                NVARCHAR(MAX)    NOT NULL,  -- JSON: [{ id, text, answerType, contraindicationIf }]
  horizon_days             INT              NOT NULL,
  instruction_revision_id  UNIQUEIDENTIFIER NULL,
  status                   NVARCHAR(20)     NOT NULL CONSTRAINT df_cp_status DEFAULT N'draft',
  created_by               UNIQUEIDENTIFIER NOT NULL,
  created_at               DATETIME2(3)     NOT NULL CONSTRAINT df_cp_created DEFAULT SYSUTCDATETIME(),
  approved_by              UNIQUEIDENTIFIER NULL,
  approved_at              DATETIME2(3)     NULL,
  CONSTRAINT pk_clinic_exam_profiles PRIMARY KEY (id),
  CONSTRAINT fk_cp_tenant FOREIGN KEY (tenant_id) REFERENCES studio.tenants (id),
  CONSTRAINT fk_cp_protocol FOREIGN KEY (protocol_revision_id) REFERENCES studio.knowledge_revisions (id),
  CONSTRAINT fk_cp_instruction FOREIGN KEY (instruction_revision_id) REFERENCES studio.knowledge_revisions (id),
  CONSTRAINT ck_cp_status CHECK (status IN (N'draft', N'approved', N'withdrawn')),
  CONSTRAINT ck_cp_questions_json CHECK (ISJSON(questions) = 1),
  CONSTRAINT ck_cp_horizon CHECK (horizon_days BETWEEN 1 AND 365),
  CONSTRAINT ck_cp_independent CHECK (approved_by IS NULL OR approved_by <> created_by)
);
CREATE UNIQUE INDEX ux_cp_key_rev ON studio.clinic_exam_profiles (profile_key, revision_no);
GO

ALTER SECURITY POLICY security.tenant_isolation
  ADD FILTER PREDICATE security.fn_tenant_access(tenant_id) ON studio.agents,
  ADD BLOCK  PREDICATE security.fn_tenant_access(tenant_id) ON studio.agents AFTER INSERT,
  ADD FILTER PREDICATE security.fn_tenant_access(tenant_id) ON studio.agent_drafts,
  ADD BLOCK  PREDICATE security.fn_tenant_access(tenant_id) ON studio.agent_drafts AFTER INSERT,
  ADD BLOCK  PREDICATE security.fn_tenant_access(tenant_id) ON studio.agent_drafts AFTER UPDATE,
  ADD FILTER PREDICATE security.fn_tenant_access(tenant_id) ON studio.agent_candidates,
  ADD BLOCK  PREDICATE security.fn_tenant_access(tenant_id) ON studio.agent_candidates AFTER INSERT,
  ADD FILTER PREDICATE security.fn_tenant_access(tenant_id) ON studio.clinic_exam_profiles,
  ADD BLOCK  PREDICATE security.fn_tenant_access(tenant_id) ON studio.clinic_exam_profiles AFTER INSERT,
  ADD BLOCK  PREDICATE security.fn_tenant_access(tenant_id) ON studio.clinic_exam_profiles AFTER UPDATE;
GO
