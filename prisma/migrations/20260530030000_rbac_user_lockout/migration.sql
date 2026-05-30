-- Migration: rbac_user_lockout (SDD #6a auth-hardening, Phase 3)
-- Additive: account lockout fields on RbacUser. Safe to deploy directly.

-- AlterTable
ALTER TABLE "RbacUser" ADD COLUMN "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lockedUntil" TIMESTAMP(3);
