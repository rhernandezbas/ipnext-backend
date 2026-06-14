-- iclass-os-actions (Ola B) — IClass team catalog (aditiva, clone de IClassNode keyed by login).
-- Prisma wraps each migration in its own transaction; no BEGIN/COMMIT here.

CREATE TABLE IF NOT EXISTS "IClassTeam" (
    "id" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "thirdPartyCode" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "selectable" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "IClassTeam_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "IClassTeam_login_key" ON "IClassTeam"("login");
CREATE INDEX IF NOT EXISTS "IClassTeam_active_idx" ON "IClassTeam"("active");
