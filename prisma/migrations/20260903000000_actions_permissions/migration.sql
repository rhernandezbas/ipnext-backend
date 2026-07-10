-- Migration: 20260903000000_actions_permissions
-- Seeds the 'actions' RBAC module (actions-worklist) + read/manage permissions +
-- grants them to 'super_admin' and 'administrador' roles.
-- Idempotent: INSERT ... ON CONFLICT DO NOTHING throughout.
-- No explicit transaction block (Prisma wraps each migration in its own transaction).

-- ─── 1. Seed the actions module ──────────────────────────────────────────────

INSERT INTO "RbacModule" ("id", "code", "label")
VALUES (gen_random_uuid(), 'actions', 'Acciones')
ON CONFLICT ("code") DO NOTHING;

-- ─── 2. Seed actions.read permission ─────────────────────────────────────────

INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'read'
FROM "RbacModule" m
WHERE m."code" = 'actions'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- ─── 3. Seed actions.manage permission ───────────────────────────────────────

INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'manage'
FROM "RbacModule" m
WHERE m."code" = 'actions'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- ─── 4. Grant actions.read to super_admin ────────────────────────────────────

INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'super_admin'
  AND m."code" = 'actions'
  AND p."action" = 'read'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ─── 5. Grant actions.manage to super_admin ──────────────────────────────────

INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'super_admin'
  AND m."code" = 'actions'
  AND p."action" = 'manage'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ─── 6. Grant actions.read to administrador ──────────────────────────────────

INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'administrador'
  AND m."code" = 'actions'
  AND p."action" = 'read'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ─── 7. Grant actions.manage to administrador ────────────────────────────────

INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'administrador'
  AND m."code" = 'actions'
  AND p."action" = 'manage'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
