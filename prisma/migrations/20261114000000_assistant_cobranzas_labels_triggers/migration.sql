-- ai-assistant-cobranzas — Fase 1 (Lote A)
--
-- 100% aditivo: ADD COLUMN con default + INSERT ... ON CONFLICT DO NOTHING. Sin backfill,
-- revertible dejando la columna (design.md — Diff Prisma).

-- AlterTable
ALTER TABLE "AssistantIntent" ADD COLUMN "labels" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "AssistantIntent" ADD COLUMN "triggerPatterns" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Client" ADD COLUMN "grPaymentUrl" TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Seed IDEMPOTENTE de catálogo (mismo patrón que 20261023000000_ai_assistant_multiagent):
-- el deploy corre `migrate deploy` pero NO `prisma db seed`, así que los datos canónicos
-- de este change se bootstrappean acá.
-- ─────────────────────────────────────────────────────────────────────────────

-- D2/ACT-3 — acción `handoff`, `riskLevel:'green'`: deriva con etiqueta y NUNCA le habla
-- al cliente.
INSERT INTO "AssistantAction" ("key", "label", "riskLevel", "updatedAt")
VALUES ('handoff', 'Derivar a un humano con etiqueta', 'green', CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

-- D8/DAT-1..2 — fuente `cliente.facturas`: detalle de facturas impagas + links de pago,
-- anclada al cliente y sin PII (proyección del SELECT en el adapter, DAT-2).
INSERT INTO "AssistantDataSource" ("key", "label", "enabled", "updatedAt")
VALUES ('cliente.facturas', 'Facturas y links de pago', true, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
