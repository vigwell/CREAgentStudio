-- 0002: Knowledge Library (spec rev 7, sections 04-05 and data model).
-- Sources (device protocols, clinical rules, reference documents) with
-- immutable revisions of mapped rows; the original file is kept with its checksum.
-- Import validation is structural; clinical approval is a separate step.

CREATE TABLE studio.knowledge_sources (
  id                 UNIQUEIDENTIFIER NOT NULL CONSTRAINT df_ks_id DEFAULT NEWSEQUENTIALID(),
  tenant_id          UNIQUEIDENTIFIER NOT NULL,
  kind               NVARCHAR(30)     NOT NULL,
  name               NVARCHAR(200)    NOT NULL,
  issuing_org        NVARCHAR(200)    NULL,
  created_by         UNIQUEIDENTIFIER NOT NULL,
  created_at         DATETIME2(3)     NOT NULL CONSTRAINT df_ks_created DEFAULT SYSUTCDATETIME(),
  CONSTRAINT pk_knowledge_sources PRIMARY KEY (id),
  CONSTRAINT fk_ks_tenant FOREIGN KEY (tenant_id) REFERENCES studio.tenants (id),
  CONSTRAINT ck_ks_kind CHECK (kind IN (N'device_protocol', N'clinical_rule', N'reference_document'))
);
CREATE UNIQUE INDEX ux_ks_tenant_name ON studio.knowledge_sources (tenant_id, name);

-- Original uploaded file (kept as uploaded; never rewritten).
CREATE TABLE studio.knowledge_files (
  id                 UNIQUEIDENTIFIER NOT NULL CONSTRAINT df_kf_id DEFAULT NEWSEQUENTIALID(),
  tenant_id          UNIQUEIDENTIFIER NOT NULL,
  original_filename  NVARCHAR(260)    NOT NULL,
  file_type          NVARCHAR(10)     NOT NULL,
  size_bytes         INT              NOT NULL,
  sha256             CHAR(64)         NOT NULL,
  content            VARBINARY(MAX)   NOT NULL,
  uploaded_by        UNIQUEIDENTIFIER NOT NULL,
  uploaded_at        DATETIME2(3)     NOT NULL CONSTRAINT df_kf_uploaded DEFAULT SYSUTCDATETIME(),
  CONSTRAINT pk_knowledge_files PRIMARY KEY (id),
  CONSTRAINT fk_kf_tenant FOREIGN KEY (tenant_id) REFERENCES studio.tenants (id),
  CONSTRAINT ck_kf_type CHECK (file_type IN (N'xlsx', N'csv'))
);
CREATE INDEX ix_kf_tenant_sha ON studio.knowledge_files (tenant_id, sha256);

CREATE TABLE studio.knowledge_revisions (
  id                 UNIQUEIDENTIFIER NOT NULL CONSTRAINT df_kr_id DEFAULT NEWSEQUENTIALID(),
  tenant_id          UNIQUEIDENTIFIER NOT NULL,
  source_id          UNIQUEIDENTIFIER NOT NULL,
  revision_no        INT              NOT NULL,
  file_id            UNIQUEIDENTIFIER NOT NULL,
  sheet_name         NVARCHAR(100)    NULL,
  header_row         INT              NOT NULL,
  mapping            NVARCHAR(MAX)    NOT NULL,  -- JSON: { "<column header>": "<canonical field>" }
  scope              NVARCHAR(MAX)    NULL,      -- JSON: site, department, modality, devices, population
  clinical_owner     NVARCHAR(200)    NOT NULL,
  effective_from     DATE             NULL,
  review_due         DATE             NOT NULL,
  status             NVARCHAR(20)     NOT NULL CONSTRAINT df_kr_status DEFAULT N'draft',
  row_count          INT              NOT NULL,
  error_count        INT              NOT NULL,
  rows_sha256        CHAR(64)         NOT NULL,  -- checksum of the normalized rows
  created_by         UNIQUEIDENTIFIER NOT NULL,
  created_at         DATETIME2(3)     NOT NULL CONSTRAINT df_kr_created DEFAULT SYSUTCDATETIME(),
  submitted_by       UNIQUEIDENTIFIER NULL,
  submitted_at       DATETIME2(3)     NULL,
  approved_by        UNIQUEIDENTIFIER NULL,
  approved_at        DATETIME2(3)     NULL,
  withdrawn_by       UNIQUEIDENTIFIER NULL,
  withdrawn_at       DATETIME2(3)     NULL,
  CONSTRAINT pk_knowledge_revisions PRIMARY KEY (id),
  CONSTRAINT fk_kr_tenant FOREIGN KEY (tenant_id) REFERENCES studio.tenants (id),
  CONSTRAINT fk_kr_source FOREIGN KEY (source_id) REFERENCES studio.knowledge_sources (id),
  CONSTRAINT fk_kr_file FOREIGN KEY (file_id) REFERENCES studio.knowledge_files (id),
  CONSTRAINT ck_kr_status CHECK (status IN (N'draft', N'in_review', N'approved', N'withdrawn')),
  CONSTRAINT ck_kr_mapping_json CHECK (ISJSON(mapping) = 1),
  CONSTRAINT ck_kr_scope_json CHECK (scope IS NULL OR ISJSON(scope) = 1),
  -- Independent approval: the approver is not the author.
  CONSTRAINT ck_kr_independent CHECK (approved_by IS NULL OR approved_by <> created_by)
);
CREATE UNIQUE INDEX ux_kr_source_no ON studio.knowledge_revisions (source_id, revision_no);
CREATE INDEX ix_kr_tenant_status ON studio.knowledge_revisions (tenant_id, status);

-- Normalized rows behind the simple UI. cells keeps every column (display),
-- mapped holds only explicitly mapped canonical fields; errors are row/cell level.
CREATE TABLE studio.knowledge_rows (
  id                 BIGINT IDENTITY(1,1) NOT NULL,
  tenant_id          UNIQUEIDENTIFIER NOT NULL,
  revision_id        UNIQUEIDENTIFIER NOT NULL,
  row_id             NVARCHAR(100)    NOT NULL,  -- stable id (mapped rowId, else sheet!row)
  original_row       INT              NOT NULL,  -- 1-based row in the sheet / file
  cells              NVARCHAR(MAX)    NOT NULL,  -- JSON: { "<header>": { "v": value, "ref": "C12" } }
  mapped             NVARCHAR(MAX)    NOT NULL,  -- JSON: { "<canonical field>": value }
  errors             NVARCHAR(MAX)    NULL,      -- JSON: [ { field, ref, message } ]
  CONSTRAINT pk_knowledge_rows PRIMARY KEY (id),
  CONSTRAINT fk_krow_tenant FOREIGN KEY (tenant_id) REFERENCES studio.tenants (id),
  CONSTRAINT fk_krow_revision FOREIGN KEY (revision_id) REFERENCES studio.knowledge_revisions (id),
  CONSTRAINT ck_krow_cells_json CHECK (ISJSON(cells) = 1),
  CONSTRAINT ck_krow_mapped_json CHECK (ISJSON(mapped) = 1),
  CONSTRAINT ck_krow_errors_json CHECK (errors IS NULL OR ISJSON(errors) = 1)
);
CREATE INDEX ix_krow_revision ON studio.knowledge_rows (revision_id, original_row);
GO

-- Rows of a revision never change once it left draft (revisions are immutable).
CREATE TRIGGER studio.tr_knowledge_rows_immutable
ON studio.knowledge_rows
AFTER UPDATE, DELETE
AS
BEGIN
  SET NOCOUNT ON;
  IF EXISTS (
    SELECT 1 FROM deleted d
    JOIN studio.knowledge_revisions r ON r.id = d.revision_id
    WHERE r.status <> N'draft'
  )
    THROW 51001, 'rows of a submitted or approved revision cannot change', 1;
END;
GO

ALTER SECURITY POLICY security.tenant_isolation
  ADD FILTER PREDICATE security.fn_tenant_access(tenant_id) ON studio.knowledge_sources,
  ADD BLOCK  PREDICATE security.fn_tenant_access(tenant_id) ON studio.knowledge_sources AFTER INSERT,
  ADD FILTER PREDICATE security.fn_tenant_access(tenant_id) ON studio.knowledge_files,
  ADD BLOCK  PREDICATE security.fn_tenant_access(tenant_id) ON studio.knowledge_files AFTER INSERT,
  ADD FILTER PREDICATE security.fn_tenant_access(tenant_id) ON studio.knowledge_revisions,
  ADD BLOCK  PREDICATE security.fn_tenant_access(tenant_id) ON studio.knowledge_revisions AFTER INSERT,
  ADD BLOCK  PREDICATE security.fn_tenant_access(tenant_id) ON studio.knowledge_revisions AFTER UPDATE,
  ADD FILTER PREDICATE security.fn_tenant_access(tenant_id) ON studio.knowledge_rows,
  ADD BLOCK  PREDICATE security.fn_tenant_access(tenant_id) ON studio.knowledge_rows AFTER INSERT;
GO
