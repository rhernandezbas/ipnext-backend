-- Migration: 20260908000100_messaging_bulk_permissions
-- Seeds the 'messaging.bulk' + 'messaging.templates' RBAC permissions (messaging-bulk F2)
-- + grants them to 'super_admin' and 'administrador' roles.
-- The 'messaging' module already exists (F1, 20260904000100_messaging_permissions) —
-- re-INSERT here is idempotent so this migration also works against a fresh DB.
-- Idempotent: INSERT ... ON CONFLICT DO NOTHING throughout.
-- No explicit transaction block (Prisma wraps each migration in its own transaction).

-- ─── 1. Re-seed the messaging module (idempotent — fresh-DB safety net) ─────

INSERT INTO "RbacModule" ("id", "code", "label")
VALUES (gen_random_uuid(), 'messaging', 'Mensajería')
ON CONFLICT ("code") DO NOTHING;

-- ─── 2. Seed messaging.bulk permission ───────────────────────────────────────

INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'bulk'
FROM "RbacModule" m
WHERE m."code" = 'messaging'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- ─── 3. Seed messaging.templates permission ──────────────────────────────────

INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'templates'
FROM "RbacModule" m
WHERE m."code" = 'messaging'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- ─── 4. Grant messaging.bulk to super_admin ──────────────────────────────────

INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'super_admin'
  AND m."code" = 'messaging'
  AND p."action" = 'bulk'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ─── 5. Grant messaging.templates to super_admin ─────────────────────────────

INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'super_admin'
  AND m."code" = 'messaging'
  AND p."action" = 'templates'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ─── 6. Grant messaging.bulk to administrador ────────────────────────────────

INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'administrador'
  AND m."code" = 'messaging'
  AND p."action" = 'bulk'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ─── 7. Grant messaging.templates to administrador ───────────────────────────

INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'administrador'
  AND m."code" = 'messaging'
  AND p."action" = 'templates'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
