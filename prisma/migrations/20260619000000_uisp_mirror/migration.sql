BEGIN;

-- ============================================================
-- UispSite table — UISP site mirror (uispId = UISP UUID, no FK to internal table)
-- ============================================================
CREATE TABLE IF NOT EXISTS "UispSite" (
  "id"             UUID         NOT NULL DEFAULT gen_random_uuid(),
  "uispId"         TEXT         NOT NULL,
  "name"           TEXT         NOT NULL,
  "status"         TEXT         NOT NULL,
  "parentUispId"   TEXT,
  "latitude"       DOUBLE PRECISION,
  "longitude"      DOUBLE PRECISION,
  "deviceCount"    INT          NOT NULL DEFAULT 0,
  "outageCount"    INT          NOT NULL DEFAULT 0,
  "contact"        TEXT,
  "missingSince"   TIMESTAMP(3),
  "lastSyncAt"     TIMESTAMP(3) NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt"      TIMESTAMP(3) NOT NULL,

  CONSTRAINT "UispSite_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UispSite_uispId_key" UNIQUE ("uispId")
);

CREATE INDEX IF NOT EXISTS "UispSite_status_idx"       ON "UispSite" ("status");
CREATE INDEX IF NOT EXISTS "UispSite_missingSince_idx"  ON "UispSite" ("missingSince");

-- ============================================================
-- UispDevice table — UISP device mirror
-- uispSiteId is the UISP site UUID (NOT an FK to UispSite.id) — intentional:
-- allows idempotent upserts without ordering constraint (sites before devices).
-- ============================================================
CREATE TABLE IF NOT EXISTS "UispDevice" (
  "id"            UUID         NOT NULL DEFAULT gen_random_uuid(),
  "uispId"        TEXT         NOT NULL,
  "uispSiteId"    TEXT         NOT NULL,
  "name"          TEXT         NOT NULL,
  "model"         TEXT         NOT NULL,
  "modelName"     TEXT,
  "type"          TEXT,
  "role"          TEXT,
  "mac"           TEXT,
  "ip"            TEXT,
  "firmware"      TEXT,
  "status"        TEXT         NOT NULL,
  "signal"        INT,
  "uptime"        BIGINT,
  "lastSeenAt"    TIMESTAMP(3),
  "missingSince"  TIMESTAMP(3),
  "lastSyncAt"    TIMESTAMP(3) NOT NULL,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt"     TIMESTAMP(3) NOT NULL,

  CONSTRAINT "UispDevice_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UispDevice_uispId_key" UNIQUE ("uispId")
);

CREATE INDEX IF NOT EXISTS "UispDevice_uispSiteId_idx"   ON "UispDevice" ("uispSiteId");
CREATE INDEX IF NOT EXISTS "UispDevice_status_idx"       ON "UispDevice" ("status");
CREATE INDEX IF NOT EXISTS "UispDevice_missingSince_idx" ON "UispDevice" ("missingSince");

-- ============================================================
-- RBAC: uisp module + read/manage permissions + super_admin grant
-- All inserts are idempotent (ON CONFLICT DO NOTHING).
-- action column is VARCHAR(64) — enum was dropped in 20260529200000.
-- ============================================================

-- 1. Seed the 'uisp' module
INSERT INTO "RbacModule" ("id", "code", "label")
SELECT gen_random_uuid(), 'uisp', 'UISP'
ON CONFLICT DO NOTHING;

-- 2. Seed uisp:read permission
INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'read'
FROM "RbacModule" m
WHERE m."code" = 'uisp'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- 3. Seed uisp:manage permission
INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'manage'
FROM "RbacModule" m
WHERE m."code" = 'uisp'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- 4. Grant uisp:read to super_admin
INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'super_admin'
  AND m."code" = 'uisp'
  AND p."action" = 'read'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- 5. Grant uisp:manage to super_admin
INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'super_admin'
  AND m."code" = 'uisp'
  AND p."action" = 'manage'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ============================================================
-- Feature flag: uisp-sync (default OFF — cron dormant until operator enables it)
-- ============================================================
INSERT INTO "FeatureFlag" ("key", "enabled", "updatedAt")
VALUES ('uisp-sync', false, NOW())
ON CONFLICT DO NOTHING;

COMMIT;
