-- Migration: 20260805001000_zones_rbac_permissions
-- Seeds the 'zones' RBAC module + zones.read / zones.manage permissions +
-- grants them to 'administrador' role.
-- Idempotent: INSERT ... ON CONFLICT DO NOTHING throughout.
-- super_admin passes via wildcard (*) — no explicit grant needed.
-- No explicit transaction block (Prisma wraps each migration in its own transaction).

-- ─── 1. Seed the zones module ─────────────────────────────────────────────────

INSERT INTO "RbacModule" ("id", "code", "label")
VALUES (gen_random_uuid(), 'zones', 'Zonas')
ON CONFLICT ("code") DO NOTHING;

-- ─── 2. Seed zones.read permission ────────────────────────────────────────────

INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'read'
FROM "RbacModule" m
WHERE m."code" = 'zones'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- ─── 3. Seed zones.manage permission ──────────────────────────────────────────

INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'manage'
FROM "RbacModule" m
WHERE m."code" = 'zones'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- ─── 4. Grant zones.read to administrador ─────────────────────────────────────

INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'administrador'
  AND m."code" = 'zones'
  AND p."action" = 'read'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ─── 5. Grant zones.manage to administrador ───────────────────────────────────

INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'administrador'
  AND m."code" = 'zones'
  AND p."action" = 'manage'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
