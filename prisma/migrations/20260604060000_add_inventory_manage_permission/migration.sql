BEGIN;

-- Seed permission inventory.manage (idempotent).
-- Note: inventory.manage was part of the initial 14-module × 4-action cross-join seed
-- (migration 20260529000000_auth_rbac_foundation), so this INSERT is mostly a safety net.
INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'manage'
FROM "RbacModule" m
WHERE m."code" = 'inventory'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- Grant inventory.manage + inventory.read to 'administrador' role (idempotent).
-- super_admin already has all permissions via the foundation migration.
INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'administrador'
  AND m."code" = 'inventory'
  AND p."action" IN ('manage', 'read')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- Grant inventory.manage to super_admin (idempotent — mirrors rbac_iclass_manual_resend pattern).
INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'super_admin'
  AND m."code" = 'inventory'
  AND p."action" = 'manage'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

COMMIT;
