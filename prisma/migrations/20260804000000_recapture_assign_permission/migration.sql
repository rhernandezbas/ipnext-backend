-- Migration: 20260804000000_recapture_assign_permission
-- Seeds the 'recapture.assign' permission and grants it to super_admin and administrador.
-- The 'recapture' module already exists from a prior migration — NOT re-inserted here.
-- Idempotent: INSERT ... ON CONFLICT DO NOTHING throughout.

-- ─── 1. Seed recapture.assign permission ─────────────────────────────────────

INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'assign'
FROM "RbacModule" m
WHERE m."code" = 'recapture'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- ─── 2. Grant recapture.assign to super_admin ────────────────────────────────

INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'super_admin'
  AND m."code" = 'recapture'
  AND p."action" = 'assign'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ─── 3. Grant recapture.assign to administrador ──────────────────────────────

INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'administrador'
  AND m."code" = 'recapture'
  AND p."action" = 'assign'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
