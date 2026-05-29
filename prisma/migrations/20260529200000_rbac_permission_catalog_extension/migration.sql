-- Migration: rbac_permission_catalog_extension
-- Phase 2 of roles-permissions-management SDD.
--
-- Changes:
--   1. Widen RbacPermission.action from Postgres enum RbacAction to VARCHAR(64).
--      Rationale: adding new sub-actions will no longer require ALTER TYPE.
--      TS source-of-truth: KNOWN_ACTIONS in src/domain/entities/rbac.ts.
--   2. Drop the now-unused RbacAction enum type.
--   3. Seed 11 new modules (idempotent via ON CONFLICT DO NOTHING).
--   4. Seed 4 base permissions × 11 new modules = 44 rows.
--   5. Seed 24 sub-action permissions across existing + new modules.
--   6. Grant all new permissions to super_admin (idempotent).
--   7. Guard: assert total module count = 25.
--
-- This migration is fully transactional and idempotent.
-- All INSERTs use ON CONFLICT DO NOTHING.

BEGIN;

-- ============================================================
-- 1. Widen action column to varchar(64).
--    USING action::text casts existing enum values to their
--    string representations ('read', 'write', 'delete', 'manage').
-- ============================================================
ALTER TABLE "RbacPermission"
  ALTER COLUMN "action" TYPE VARCHAR(64) USING "action"::text;

-- ============================================================
-- 2. Drop the now-unused enum type.
-- ============================================================
DROP TYPE IF EXISTS "RbacAction";

-- ============================================================
-- 3. Seed 11 new modules (idempotent).
-- ============================================================
INSERT INTO "RbacModule" ("id", "code", "label", "createdAt") VALUES
  (gen_random_uuid(), 'voices',        'Voz',               NOW()),
  (gen_random_uuid(), 'partners',      'Socios',            NOW()),
  (gen_random_uuid(), 'rbac',          'Roles y Permisos',  NOW()),
  (gen_random_uuid(), 'profile',       'Perfil',            NOW()),
  (gen_random_uuid(), 'notifications', 'Notificaciones',    NOW()),
  (gen_random_uuid(), 'dashboard',     'Dashboard',         NOW()),
  (gen_random_uuid(), 'portal',        'Portal',            NOW()),
  (gen_random_uuid(), 'search',        'Búsqueda',          NOW()),
  (gen_random_uuid(), 'support',       'Mensajería',        NOW()),
  (gen_random_uuid(), 'sla',           'SLA',               NOW()),
  (gen_random_uuid(), 'tariffs',       'Tarifas',           NOW())
ON CONFLICT ("code") DO NOTHING;

-- ============================================================
-- 4. Seed 4 base permissions × 11 new modules = 44 rows.
-- ============================================================
INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", a."action"
FROM "RbacModule" m
CROSS JOIN (VALUES ('read'), ('write'), ('delete'), ('manage')) AS a("action")
WHERE m."code" IN (
  'voices', 'partners', 'rbac', 'profile', 'notifications',
  'dashboard', 'portal', 'search', 'support', 'sla', 'tariffs'
)
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- ============================================================
-- 5. Seed 24 sub-action permissions (existing + new modules).
--    All 24 pairs listed explicitly.
-- ============================================================
INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", v."action"
FROM "RbacModule" m
JOIN (VALUES
  ('tickets',    'close'),
  ('tickets',    'reopen'),
  ('billing',    'void'),
  ('billing',    'send_email'),
  ('scheduling', 'send_to_iclass'),
  ('scheduling', 'bulk_delete'),
  ('scheduling', 'move_stage'),
  ('scheduling', 'manage_checklist'),
  ('monitoring', 'acknowledge_alert'),
  ('network',    'manage_gpon'),
  ('network',    'manage_sites'),
  ('iclass',     'sync'),
  ('iclass',     'assign_to_project'),
  ('clients',    'manage_documents'),
  ('clients',    'manage_online_sessions'),
  ('admin',      'view_activity_log'),
  ('admin',      'manage_2fa'),
  ('rbac',       'manage_users'),
  ('rbac',       'manage_user_roles'),
  ('rbac',       'change_user_password'),
  ('rbac',       'manage_roles'),
  ('profile',    'change_own_password'),
  ('settings',   'manage_api_tokens'),
  ('settings',   'manage_backups')
) AS v("module_code", "action") ON m."code" = v."module_code"
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- ============================================================
-- 6. Grant ALL permissions to super_admin (idempotent).
--    After this step super_admin owns every permission row.
-- ============================================================
INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
WHERE r."code" = 'super_admin'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ============================================================
-- 7. Guard: total module count must be exactly 25.
--    (14 original + 11 new)
-- ============================================================
DO $$
DECLARE
  module_count INT;
BEGIN
  SELECT COUNT(*) INTO module_count FROM "RbacModule";
  IF module_count <> 25 THEN
    RAISE EXCEPTION 'Guard failed: RbacModule count expected 25, got %', module_count;
  END IF;
END $$;

COMMIT;
