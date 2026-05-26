-- Down (manual): would require recreating the AdminRole enum and casting back.

-- Make Admin.role free text (was the AdminRole enum) so any role-definition
-- name from the AdminRoleDefinition catalog can be assigned. Existing values
-- (superadmin/admin/viewer/…) are preserved by the ::text cast.
ALTER TABLE "Admin" ALTER COLUMN "role" TYPE TEXT USING "role"::text;

-- Seed the role definitions that existed in the enum but were never added to
-- the catalog, so the editable role dropdown shows all of them by default.
INSERT INTO "admin_role_definitions" ("id", "name", "description", "isSystem", "permissions", "createdAt", "updatedAt") VALUES
  ('c1000001-0000-4000-8000-000000000001', 'engineer',          'Ingeniero de red',   false, '[{"module":"network","actions":["read","write"]},{"module":"scheduling","actions":["read","write"]}]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('c1000002-0000-4000-8000-000000000002', 'financial_manager', 'Gerente financiero', false, '[{"module":"billing","actions":["read","write","delete"]},{"module":"clients","actions":["read"]}]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('c1000003-0000-4000-8000-000000000003', 'support_agent',     'Agente de soporte',  false, '[{"module":"tickets","actions":["read","write"]},{"module":"clients","actions":["read"]}]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('c1000004-0000-4000-8000-000000000004', 'technician',        'Técnico de campo',   false, '[{"module":"scheduling","actions":["read","write"]}]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO NOTHING;
