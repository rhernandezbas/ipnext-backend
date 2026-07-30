-- Grant portal.manage so the customer-portal-api admin CRUD (Fase 3) is reachable
-- by normal admins, not just super_admin.
--
-- Context: the RBAC foundation migration (20260529000000_auth_rbac_foundation) grants
-- ALL permissions ONLY to super_admin; every other role starts with ZERO grants
-- ("configured from UI"). 'administrador' received inventory.manage / clients.manage /
-- tickets.manage via dedicated idempotent migrations later (e.g.
-- 20260604060000_add_inventory_manage_permission, 20260627000000_grant_clients_manage),
-- which `migrate deploy` applies in prod (seed.ts is dev-only). This migration replicates
-- that exact pattern for portal.manage so the /api/admin/portal-accounts CRUD does not
-- 403 for administradores.
--
-- Note: the 'portal' RbacModule and its base 'manage' RbacPermission row ALREADY exist —
-- seeded by 20260529200000_rbac_permission_catalog_extension's 4-base-actions x 11-new-
-- modules cross join (module 'portal' was one of those 11), and super_admin already
-- holds portal.manage via that same migration's "grant ALL to super_admin" step. Step 1
-- below is therefore a safety net (mirrors inventory.manage's "mostly a safety net" note)
-- — the real gap this migration closes is step 2, granting it to 'administrador'.
--
-- Idempotent: INSERT ... SELECT ... CROSS JOIN ... ON CONFLICT DO NOTHING. No explicit
-- transaction block (Prisma wraps each migration in its own transaction).

-- 1. Seed the portal.manage permission (idempotent — safety net, see note above).
INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'manage'
FROM "RbacModule" m
WHERE m."code" = 'portal'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- 2. Grant portal.manage to 'administrador' (idempotent — mirrors inventory.manage/clients.manage).
--    super_admin already has it via the catalog-extension migration; granted again below
--    as a safety net (mirrors the same pattern).
INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'administrador'
  AND m."code" = 'portal'
  AND p."action" = 'manage'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- 3. Grant portal.manage to 'super_admin' (idempotent safety net — mirrors the pattern).
INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'super_admin'
  AND m."code" = 'portal'
  AND p."action" = 'manage'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
