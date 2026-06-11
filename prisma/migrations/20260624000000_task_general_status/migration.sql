-- Migration: task_general_status (#41)
-- Additive: ADD COLUMN ... DEFAULT is metadata-only in PG (no table rewrite).
-- Backfill is idempotent — re-running maps any isClosed=true row to 'closed' once.
ALTER TABLE "ScheduledTask"
  ADD COLUMN IF NOT EXISTS "generalStatus" TEXT NOT NULL DEFAULT 'open';

UPDATE "ScheduledTask" SET "generalStatus" = 'closed'
  WHERE "isClosed" = true AND "generalStatus" <> 'closed';
