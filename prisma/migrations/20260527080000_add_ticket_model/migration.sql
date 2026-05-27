-- Support domain: Ticket model (real Prominense data with FK to Client/Admin).
-- Additive — does not touch existing tables.

CREATE TYPE "TicketStatus" AS ENUM ('open', 'pending', 'closed');
CREATE TYPE "TicketPriority" AS ENUM ('low', 'medium', 'high');

CREATE TABLE "Ticket" (
    "id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'open',
    "priority" "TicketPriority" NOT NULL DEFAULT 'medium',
    "customerId" TEXT,
    "assigneeId" TEXT,
    "grCasoId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Ticket_grCasoId_key" ON "Ticket"("grCasoId");
CREATE INDEX "Ticket_customerId_idx" ON "Ticket"("customerId");
CREATE INDEX "Ticket_status_idx" ON "Ticket"("status");
CREATE INDEX "Ticket_assigneeId_idx" ON "Ticket"("assigneeId");

ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_assigneeId_fkey"
  FOREIGN KEY ("assigneeId") REFERENCES "Admin"("id") ON DELETE SET NULL ON UPDATE CASCADE;
