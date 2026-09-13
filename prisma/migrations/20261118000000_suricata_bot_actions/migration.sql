-- suricata-bot-autonomous-actions (Phase A, tasks A.1/A.2, design D1/D2).
--
-- ONE unified, append-only audit table for the four autonomous write actions
-- (reply/close/status/note), `actionType`-discriminated, `payload` a JSONB
-- column NOT NULL (D1.a — the DB enforces "content is always present",
-- per-type shape safety lives in the domain's discriminated union).
--
-- Hand-authored (no local DB to run `prisma migrate diff --from-migrations`,
-- which requires a shadow database) — molde verbatim the CREATE TABLE shape
-- of "SuricataReplyAudit"/"SuricataSyncRun" in
-- 20261116000000_suricata_tickets_mirror_base/migration.sql (same column
-- type conventions: TEXT, JSONB, TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP).
--
-- No BEGIN/COMMIT (Prisma wraps each migration in its own transaction, per
-- 20261028000000_iclass_gps_ingest_flag's established rule in this repo).
-- CreateTable
CREATE TABLE "SuricataBotActionAudit" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "actorLogin" TEXT NOT NULL,
    "outcome" TEXT NOT NULL DEFAULT 'failed',
    "error" TEXT,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "SuricataBotActionAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SuricataBotActionAudit_ticketId_attemptedAt_idx" ON "SuricataBotActionAudit"("ticketId", "attemptedAt");

-- CreateIndex
CREATE INDEX "SuricataBotActionAudit_actionType_attemptedAt_idx" ON "SuricataBotActionAudit"("actionType", "attemptedAt");

-- AddForeignKey
ALTER TABLE "SuricataBotActionAudit" ADD CONSTRAINT "SuricataBotActionAudit_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "SuricataTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Feature flags: suricata-bot-{reply,close,status,note}-enabled (default OFF
-- — DARK). Design D2 — the `-bot-` infix is load-bearing: `suricata-reply-enabled`
-- already exists and governs the INTERNAL human route; reusing it would
-- couple one flip to both surfaces, which the non-goals forbid.
--
-- Idempotent: ON CONFLICT DO NOTHING on the PK `key` — molde verbatim
-- 20261117000000_seed_suricata_verdict_flag/migration.sql. Seeding only in
-- seed.ts is forbidden here for the same mechanical reason: `SetFeatureFlag`
-- does an `update`, never an `upsert` — with no row, the flag can never be
-- turned on from the flags UI.
INSERT INTO "FeatureFlag" ("key", "enabled", "updatedAt")
VALUES ('suricata-bot-reply-enabled', false, NOW())
ON CONFLICT DO NOTHING;

INSERT INTO "FeatureFlag" ("key", "enabled", "updatedAt")
VALUES ('suricata-bot-close-enabled', false, NOW())
ON CONFLICT DO NOTHING;

INSERT INTO "FeatureFlag" ("key", "enabled", "updatedAt")
VALUES ('suricata-bot-status-enabled', false, NOW())
ON CONFLICT DO NOTHING;

INSERT INTO "FeatureFlag" ("key", "enabled", "updatedAt")
VALUES ('suricata-bot-note-enabled', false, NOW())
ON CONFLICT DO NOTHING;
