-- gigared-tv (#47) — Gigared Partners TV integration (aditiva).
-- Prisma wraps each migration in its own transaction; no BEGIN/COMMIT here.

-- ============================================================
-- GigaredConfig — single-row config (id = 'singleton'). Empty apiKey = unconfigured.
-- ============================================================
CREATE TABLE "GigaredConfig" (
    "id"        TEXT         NOT NULL DEFAULT 'singleton',
    "apiKey"    TEXT         NOT NULL DEFAULT '',
    "baseUrl"   TEXT         NOT NULL DEFAULT 'https://partners.gigaredsa.com.ar/api/v1',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GigaredConfig_pkey" PRIMARY KEY ("id")
);

-- ============================================================
-- RBAC: 'tv' module + read/write/manage permissions.
-- Grants to super_admin AND administrador (both roles — proposal). All idempotent.
-- action column is VARCHAR(64) — enum was dropped in 20260529200000.
-- ============================================================

-- 1. Seed the 'tv' module
INSERT INTO "RbacModule" ("id", "code", "label")
SELECT gen_random_uuid(), 'tv', 'TV / Gigared'
ON CONFLICT DO NOTHING;

-- 2. Seed tv:read / tv:write / tv:manage permissions
INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", a."action"
FROM "RbacModule" m
CROSS JOIN (VALUES ('read'), ('write'), ('manage')) AS a("action")
WHERE m."code" = 'tv'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- 3. Grant all 3 tv permissions to super_admin AND administrador
INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE m."code" = 'tv'
  AND r."code" IN ('super_admin', 'administrador')
  AND p."action" IN ('read', 'write', 'manage')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ============================================================
-- Feature flag: gigared-integration (default OFF — kill switch / not-configured guard).
-- ============================================================
INSERT INTO "FeatureFlag" ("key", "enabled", "updatedAt")
VALUES ('gigared-integration', false, NOW())
ON CONFLICT DO NOTHING;
