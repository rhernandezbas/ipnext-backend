-- Migration: tickets-actions-be — additive ticketId FK on ScheduledTask
-- Stacks after: 20260601130000_rename_service_to_contract
-- Additive only: no column renames, no drops, no data loss.

-- Add nullable ticketId column to ScheduledTask
ALTER TABLE "ScheduledTask" ADD COLUMN "ticketId" TEXT;

-- FK constraint: SET NULL on ticket deletion (orphaned tasks remain intact)
ALTER TABLE "ScheduledTask"
  ADD CONSTRAINT "ScheduledTask_ticketId_fkey"
  FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Index for efficient lookup by ticketId
CREATE INDEX "ScheduledTask_ticketId_idx" ON "ScheduledTask"("ticketId");
