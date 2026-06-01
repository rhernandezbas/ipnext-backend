-- Migration: session_expires_at (session-expiration)
-- Additive + idempotent: adds the nullable "expiresAt" column to Session and
-- backfills existing rows with loginAt + 8h (== JWT MAX_AGE). Rows older than 8h
-- are thus already expired. Safe to re-run: ADD COLUMN IF NOT EXISTS + a backfill
-- guarded by "expiresAt" IS NULL.
--
-- Liveness definition (enforced in application code, not by a constraint):
--   revokedAt IS NULL AND expiresAt > now() AND lastSeenAt > now() - interval '1 hour'.
--
-- Rollback: ALTER TABLE "Session" DROP COLUMN "expiresAt"; (the column is purely
-- additive, no other object depends on it).

-- AlterTable
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);

-- Backfill: derive the absolute 8h cap from the original login time. Existing
-- sessions older than 8h become already-expired; recent ones keep their window.
UPDATE "Session"
SET "expiresAt" = "loginAt" + interval '8 hours'
WHERE "expiresAt" IS NULL;
