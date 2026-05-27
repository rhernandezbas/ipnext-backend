-- AddColumn: isClosed flag on ScheduledTask (soft-close, additive migration)
ALTER TABLE "ScheduledTask" ADD COLUMN "isClosed" BOOLEAN NOT NULL DEFAULT false;
