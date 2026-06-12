-- Grant tickets.manage so the ticket area catalog ABM (#49) is reachable by normal admins.
--
-- Context: the RBAC foundation migration (20260529000000_auth_rbac_foundation) grants
-- ALL permissions ONLY to super_admin; every other role starts with ZERO grants
-- ("configured from UI"). 'administrador' received inventory.manage / scheduling.manage
-- via dedicated idempotent migrations, which `migrate deploy` applies in prod (seed.ts is dev-only).
-- This migration replicates that exact pattern for tickets.manage.
--
-- Idempotent: INSERT ... SELECT ... CROSS JOIN ... ON CONFLICT DO NOTHING. No explicit
-- transaction block (Prisma wraps each migration in its own transaction).

-- 1. Seed the tickets.manage permission (idempotent — likely already seeded by the foundation
--    14-module x 4-action cross-join, but kept as a safety net).
INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'manage'
FROM "RbacModule" m
WHERE m."code" = 'tickets'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- 2. Grant tickets.manage to 'administrador' (idempotent — mirrors the clients.manage grant).
INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'administrador'
  AND m."code" = 'tickets'
  AND p."action" = 'manage'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- 3. Grant tickets.manage to 'super_admin' (idempotent — mirrors the clients.manage pattern).
INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'super_admin'
  AND m."code" = 'tickets'
  AND p."action" = 'manage'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
