-- 0005: the Medilis tenant (fixed id), so the Studio can be used outside tests.
-- Development: set AUTO_PROVISION_TENANT_ID to this id; the first user who
-- signs in becomes admin, later users authors.
EXEC sp_set_session_context @key = N'system', @value = 1;
IF NOT EXISTS (SELECT 1 FROM studio.tenants WHERE id = 'a6da57a3-bfe5-592d-a9a6-6c840a27d7a0')
  INSERT INTO studio.tenants (id, name) VALUES ('a6da57a3-bfe5-592d-a9a6-6c840a27d7a0', N'Medilis');
EXEC sp_set_session_context @key = N'system', @value = NULL;
GO
