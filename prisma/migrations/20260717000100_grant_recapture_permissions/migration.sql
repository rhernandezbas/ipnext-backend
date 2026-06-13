-- Migration: 20260717000100_grant_recapture_permissions
-- Seeds the 'recapture' RBAC module + read/manage permissions +
-- grants them to 'super_admin' and 'administrador' roles.
-- Idempotent: INSERT ... ON CONFLICT DO NOTHING throughout.
-- No explicit transaction block (Prisma wraps each migration in its own transaction).

-- ─── 1. Seed the recapture module ────────────────────────────────────────────

INSERT INTO "RbacModule" ("id", "code", "label")
VALUES (gen_random_uuid(), 'recapture', 'Recaptación')
ON CONFLICT ("code") DO NOTHING;

-- ─── 2. Seed recapture.read permission ───────────────────────────────────────

INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'read'
FROM "RbacModule" m
WHERE m."code" = 'recapture'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- ─── 3. Seed recapture.manage permission ─────────────────────────────────────

INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'manage'
FROM "RbacModule" m
WHERE m."code" = 'recapture'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- ─── 4. Grant recapture.read to super_admin ──────────────────────────────────

INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'super_admin'
  AND m."code" = 'recapture'
  AND p."action" = 'read'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ─── 5. Grant recapture.manage to super_admin ────────────────────────────────

INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'super_admin'
  AND m."code" = 'recapture'
  AND p."action" = 'manage'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ─── 6. Grant recapture.read to administrador ────────────────────────────────

INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'administrador'
  AND m."code" = 'recapture'
  AND p."action" = 'read'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ─── 7. Grant recapture.manage to administrador ──────────────────────────────

INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'administrador'
  AND m."code" = 'recapture'
  AND p."action" = 'manage'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
