-- Migration: service_technology
-- Change: service-technology (SDD)
--
-- Adds:
--   1. New table "ServiceTechnology" — editable catalog (mirror of TaskCategory).
--   2. Nullable column "technology" on "Service" — Phase 1 free-text name, NOT a FK.
--   3. New RBAC module "contracts" + base permissions + role grants.
--
-- Safety: fully additive (CREATE TABLE + CREATE INDEX + ALTER TABLE ADD COLUMN + INSERT).
--         No DROP, no ALTER COLUMN TYPE, no data rewrite.
-- Rollback: DROP TABLE "ServiceTechnology"; ALTER TABLE "Service" DROP COLUMN "technology";
--           DELETE FROM "RbacPermission" WHERE "moduleId" IN (SELECT id FROM "RbacModule" WHERE code = 'contracts');
--           DELETE FROM "RbacModule" WHERE code = 'contracts';

BEGIN;

-- ============================================================
-- 1. ServiceTechnology catalog table.
-- ============================================================
CREATE TABLE "ServiceTechnology" (
    "id"          TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "description" TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceTechnology_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ServiceTechnology_name_key" ON "ServiceTechnology"("name");

-- ============================================================
-- 2. Nullable "technology" column on Service (additive, no default).
--    All existing rows will have technology = NULL (expected).
-- ============================================================
ALTER TABLE "Service" ADD COLUMN "technology" TEXT;

-- ============================================================
-- 3. RBAC module "contracts" + 4 base permissions + role grants.
--
--    The deploy uses `migrate deploy` (not db seed), so the
--    permission bootstrap MUST live here — idempotent via
--    ON CONFLICT DO NOTHING.
-- ============================================================

-- 3a. Seed the contracts module.
INSERT INTO "RbacModule" ("id", "code", "label", "createdAt") VALUES
  (gen_random_uuid(), 'contracts', 'Contratos', NOW())
ON CONFLICT ("code") DO NOTHING;

-- 3b. Seed 4 base permissions for contracts.
INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", a."action"
FROM "RbacModule" m
CROSS JOIN (VALUES ('read'), ('write'), ('delete'), ('manage')) AS a("action")
WHERE m."code" = 'contracts'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- 3c. Grant all contracts permissions to super_admin (idempotent).
INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
JOIN "RbacModule" m ON m."code" = 'contracts'
JOIN "RbacPermission" p ON p."moduleId" = m."id"
WHERE r."code" = 'super_admin'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- 3d. Grant contracts.read + contracts.write to administrador role.
INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
JOIN "RbacModule" m ON m."code" = 'contracts'
JOIN "RbacPermission" p ON p."moduleId" = m."id"
WHERE r."code" = 'administrador'
  AND p."action" IN ('read', 'write')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- 3e. Grant contracts.read to administracion, ventas, noc, tecnico roles.
INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
JOIN "RbacModule" m ON m."code" = 'contracts'
JOIN "RbacPermission" p ON p."moduleId" = m."id"
WHERE r."code" IN ('administracion', 'ventas', 'noc', 'tecnico')
  AND p."action" = 'read'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ============================================================
-- 4. Canonical ServiceTechnology seed values (idempotent).
--    The deploy runs migrate deploy (not db seed) so seeding
--    lives here too.
-- ============================================================
INSERT INTO "ServiceTechnology" ("id", "name", "description", "createdAt", "updatedAt") VALUES
  (gen_random_uuid(), 'Fiber',    'Fibra óptica',             NOW(), NOW()),
  (gen_random_uuid(), 'DOCSIS',   'Cable / HFC DOCSIS',       NOW(), NOW()),
  (gen_random_uuid(), 'Wireless', 'Enlace inalámbrico',       NOW(), NOW()),
  (gen_random_uuid(), 'FTTH',     'Fiber to the home',        NOW(), NOW()),
  (gen_random_uuid(), 'HFC',      'Híbrido fibra-coaxial',    NOW(), NOW()),
  (gen_random_uuid(), 'Radio',    'Radioenlace',              NOW(), NOW())
ON CONFLICT ("name") DO NOTHING;

COMMIT;
