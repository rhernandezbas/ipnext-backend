-- Grant clients.manage so the service-catalog ABM (#43) is reachable by normal admins.
--
-- Context: the RBAC foundation migration (20260529000000_auth_rbac_foundation) grants
-- ALL permissions ONLY to super_admin; every other role starts with ZERO grants
-- ("configured from UI"). 'administrador' received inventory.manage / scheduling.manage
-- via dedicated idempotent migrations later (e.g. 20260604060000_add_inventory_manage_permission),
-- which `migrate deploy` applies in prod (seed.ts is dev-only). This migration replicates
-- that exact pattern for clients.manage so the catalog ABM does not 403 for administradores.
--
-- Idempotent: INSERT ... SELECT ... CROSS JOIN ... ON CONFLICT DO NOTHING. No explicit
-- transaction block (Prisma wraps each migration in its own transaction).

-- 1. Seed the clients.manage permission (idempotent — likely already seeded by the foundation
--    14-module x 4-action cross-join, but kept as a safety net).
INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'manage'
FROM "RbacModule" m
WHERE m."code" = 'clients'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- 2. Grant clients.manage to 'administrador' (idempotent — mirrors the inventory.manage grant).
--    super_admin already has it via the foundation migration; granted again below as a safety net.
INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'administrador'
  AND m."code" = 'clients'
  AND p."action" = 'manage'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- 3. Grant clients.manage to 'super_admin' (idempotent — mirrors the inventory.manage pattern).
INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'super_admin'
  AND m."code" = 'clients'
  AND p."action" = 'manage'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
