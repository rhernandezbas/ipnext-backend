-- Migration: 20260904000100_messaging_permissions
-- Seeds the 'messaging' RBAC module (messaging-inbox F1) + read/send permissions +
-- grants them to 'super_admin' and 'administrador' roles.
-- Idempotent: INSERT ... ON CONFLICT DO NOTHING throughout.
-- No explicit transaction block (Prisma wraps each migration in its own transaction).

-- ─── 1. Seed the messaging module ────────────────────────────────────────────

INSERT INTO "RbacModule" ("id", "code", "label")
VALUES (gen_random_uuid(), 'messaging', 'Mensajería')
ON CONFLICT ("code") DO NOTHING;

-- ─── 2. Seed messaging.read permission ───────────────────────────────────────

INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'read'
FROM "RbacModule" m
WHERE m."code" = 'messaging'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- ─── 3. Seed messaging.send permission ───────────────────────────────────────

INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'send'
FROM "RbacModule" m
WHERE m."code" = 'messaging'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- ─── 4. Grant messaging.read to super_admin ──────────────────────────────────

INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'super_admin'
  AND m."code" = 'messaging'
  AND p."action" = 'read'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ─── 5. Grant messaging.send to super_admin ──────────────────────────────────

INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'super_admin'
  AND m."code" = 'messaging'
  AND p."action" = 'send'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ─── 6. Grant messaging.read to administrador ────────────────────────────────

INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'administrador'
  AND m."code" = 'messaging'
  AND p."action" = 'read'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ─── 7. Grant messaging.send to administrador ────────────────────────────────

INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'administrador'
  AND m."code" = 'messaging'
  AND p."action" = 'send'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
