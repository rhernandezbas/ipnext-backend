-- Migration: 20260717000000_recapture_leads
-- Creates RecaptureLead + RecaptureContact tables with 4 enums for the Recaptación feature (#80).
-- Additive — no BEGIN/COMMIT (Prisma wraps each migration in its own transaction).
-- All DDL is idempotent (IF NOT EXISTS).

-- ─── Enums ───────────────────────────────────────────────────────────────────

CREATE TYPE IF NOT EXISTS "RecaptureLeadSource" AS ENUM ('churned_client', 'csv');
CREATE TYPE IF NOT EXISTS "RecaptureLeadStatus" AS ENUM ('nuevo', 'en_gestion', 'contactado', 'interesado', 'recuperado', 'descartado');
CREATE TYPE IF NOT EXISTS "RecaptureContactChannel" AS ENUM ('llamada', 'whatsapp', 'email', 'sms', 'otro');
CREATE TYPE IF NOT EXISTS "RecaptureContactOutcome" AS ENUM ('sin_respuesta', 'contactado', 'no_interesado', 'interesado', 'recuperado', 'numero_erroneo');

-- ─── RecaptureLead ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "RecaptureLead" (
  "id"          TEXT NOT NULL,
  "source"      "RecaptureLeadSource" NOT NULL,
  "clientId"    TEXT,
  "contactName" TEXT NOT NULL,
  "phone"       TEXT,
  "email"       TEXT,
  "status"      "RecaptureLeadStatus" NOT NULL DEFAULT 'nuevo',
  "assigneeId"  TEXT,
  "claimedAt"   TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "RecaptureLead_pkey" PRIMARY KEY ("id")
);

-- FK: clientId -> Client (optional — SET NULL on delete)
ALTER TABLE "RecaptureLead"
  ADD CONSTRAINT "RecaptureLead_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- FK: assigneeId -> RbacUser (optional — SET NULL on delete)
ALTER TABLE "RecaptureLead"
  ADD CONSTRAINT "RecaptureLead_assigneeId_fkey"
  FOREIGN KEY ("assigneeId") REFERENCES "RbacUser"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Standard indexes
CREATE INDEX IF NOT EXISTS "RecaptureLead_status_idx"     ON "RecaptureLead"("status");
CREATE INDEX IF NOT EXISTS "RecaptureLead_assigneeId_idx" ON "RecaptureLead"("assigneeId");
CREATE INDEX IF NOT EXISTS "RecaptureLead_clientId_idx"   ON "RecaptureLead"("clientId");

-- Partial unique index: one lead per baja client (idempotent seed).
-- Prisma cannot express partial unique in schema.prisma — declared here manually.
CREATE UNIQUE INDEX IF NOT EXISTS "RecaptureLead_clientId_churned_key"
  ON "RecaptureLead"("clientId")
  WHERE "source" = 'churned_client' AND "clientId" IS NOT NULL;

-- ─── RecaptureContact ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "RecaptureContact" (
  "id"         TEXT NOT NULL,
  "leadId"     TEXT NOT NULL,
  "actorId"    TEXT NOT NULL,
  "channel"    "RecaptureContactChannel" NOT NULL,
  "outcome"    "RecaptureContactOutcome" NOT NULL,
  "proposal"   TEXT,
  "note"       TEXT,
  "nextStepAt" TIMESTAMP(3),
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "RecaptureContact_pkey" PRIMARY KEY ("id")
);

-- FK: leadId -> RecaptureLead (CASCADE delete)
ALTER TABLE "RecaptureContact"
  ADD CONSTRAINT "RecaptureContact_leadId_fkey"
  FOREIGN KEY ("leadId") REFERENCES "RecaptureLead"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- FK: actorId -> RbacUser (restrict — contacts must reference a real user)
ALTER TABLE "RecaptureContact"
  ADD CONSTRAINT "RecaptureContact_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "RbacUser"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Standard indexes
CREATE INDEX IF NOT EXISTS "RecaptureContact_leadId_idx"  ON "RecaptureContact"("leadId");
CREATE INDEX IF NOT EXISTS "RecaptureContact_actorId_idx" ON "RecaptureContact"("actorId");
