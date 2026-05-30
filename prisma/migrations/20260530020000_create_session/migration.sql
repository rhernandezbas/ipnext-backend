-- Migration: create_session (SDD #5 sessions-management, Phase 1)
-- Additive: Session table (stateful auth, tokenHash unique) + idempotent seed of
-- admin.view_sessions / admin.revoke_sessions + grant to super_admin.

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "rbacUserId" TEXT NOT NULL,
    "actorLogin" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "loginAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");
CREATE INDEX "Session_rbacUserId_idx" ON "Session"("rbacUserId");
CREATE INDEX "Session_revokedAt_idx" ON "Session"("revokedAt");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_rbacUserId_fkey" FOREIGN KEY ("rbacUserId") REFERENCES "RbacUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed the two new admin sub-actions (idempotent).
INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", v."action"
FROM "RbacModule" m
JOIN (VALUES ('admin', 'view_sessions'), ('admin', 'revoke_sessions')) AS v("module_code", "action")
  ON m."code" = v."module_code"
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- Grant ALL permissions to super_admin (idempotent) — picks up the two new ones.
INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
WHERE r."code" = 'super_admin'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
