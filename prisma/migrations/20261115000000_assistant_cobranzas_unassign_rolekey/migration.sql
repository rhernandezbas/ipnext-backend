-- ai-assistant-cobranzas — enmienda D9–D11 (Lote G0)
--
-- 100% aditivo: ADD COLUMN con default + INSERT ... ON CONFLICT DO NOTHING. Sin backfill,
-- revertible dejando la columna (design.md — Diff Prisma, segunda migración).

-- AlterTable
ALTER TABLE "AssistantIntent" ADD COLUMN "unassign" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AssistantIntent" ADD COLUMN "roleKey" TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Seed IDEMPOTENTE de catálogo (mismo patrón que 20261114000000_assistant_cobranzas_labels_triggers).
-- ─────────────────────────────────────────────────────────────────────────────

-- D9 — fuente `cliente.recibos_hoy`: recibos del día + match de comprobante contra GR en vivo,
-- anclada al cliente y sin PII (proyección del adapter, DAT-4).
INSERT INTO "AssistantDataSource" ("key", "label", "enabled", "updatedAt")
VALUES ('cliente.recibos_hoy', 'Recibos de hoy y match de comprobante', true, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
