-- Make scheduledDate and scheduledTime nullable to support tasks pending scheduling
ALTER TABLE "ScheduledTask" ALTER COLUMN "scheduledDate" DROP NOT NULL;
ALTER TABLE "ScheduledTask" ALTER COLUMN "scheduledTime" DROP NOT NULL;
