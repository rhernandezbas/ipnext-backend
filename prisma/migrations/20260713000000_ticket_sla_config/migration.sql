-- #79 — Ticket SLA timer config (singleton): thresholds for the tickets list
-- "Timer" column color (green→amber at warnMinutes, amber→red at dangerMinutes).
-- Additive only. No BEGIN/COMMIT (Prisma wraps each migration in its own transaction).
-- Idempotent: IF NOT EXISTS on the table, seed row via ON CONFLICT DO NOTHING.

-- CreateTable
CREATE TABLE IF NOT EXISTS "TicketSlaConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "warnMinutes" INTEGER NOT NULL DEFAULT 60,
    "dangerMinutes" INTEGER NOT NULL DEFAULT 240,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketSlaConfig_pkey" PRIMARY KEY ("id")
);

-- Seed the singleton with the sensible defaults. ON CONFLICT keeps any value an
-- operator already customized from the admin UI.
INSERT INTO "TicketSlaConfig" ("id", "warnMinutes", "dangerMinutes", "updatedAt")
VALUES ('singleton', 60, 240, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
