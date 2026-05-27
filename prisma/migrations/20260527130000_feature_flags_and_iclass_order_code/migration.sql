-- Down (manual)
-- ALTER TABLE "ScheduledTask" DROP COLUMN IF EXISTS "iclassOrderCode";
-- DROP TABLE IF EXISTS "FeatureFlag";

-- AlterTable
ALTER TABLE "ScheduledTask" ADD COLUMN     "iclassOrderCode" TEXT;

-- CreateTable
CREATE TABLE "FeatureFlag" (
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeatureFlag_pkey" PRIMARY KEY ("key")
);

-- Seed canonical feature flag (deploy runs `migrate deploy`, not `db seed`).
-- Idempotent: existing value (e.g. toggled on in prod) is preserved.
INSERT INTO "FeatureFlag" ("key", "enabled", "updatedAt")
VALUES ('iclass-integration', false, NOW())
ON CONFLICT ("key") DO NOTHING;
