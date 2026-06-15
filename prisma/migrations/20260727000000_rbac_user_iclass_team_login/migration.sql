-- Migration: 20260727000000_rbac_user_iclass_team_login
-- Adds iclassTeamLogin (soft FK to IClassTeam.login) to RbacUser.
-- Aditiva, idempotente, sin FK física (AD-1), sin BEGIN/COMMIT.

ALTER TABLE "RbacUser" ADD COLUMN IF NOT EXISTS "iclassTeamLogin" TEXT;
CREATE INDEX IF NOT EXISTS "RbacUser_iclassTeamLogin_idx" ON "RbacUser"("iclassTeamLogin");
