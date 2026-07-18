-- Migration: 20260928000000_conversation_snooze
-- conversation-snooze (Ola 6c, EPIC inbox-Chatwoot) — posponer ("snooze") una conversación
-- hasta un timestamp futuro: desaparece de Abiertas/Sin atender y reaparece sola al vencer.
--
-- 100% ADITIVA y de bajo riesgo: ADD COLUMN nullable + CREATE INDEX + seed de un feature flag.
-- Sin BEGIN/COMMIT explícito (Prisma envuelve cada migración en su propia transacción).

-- ─── 1. Conversation: snoozedUntil (aditiva, nullable) ────────────────────────────
-- status='snoozed' AND snoozedUntil>now = VIGENTE (fuera de Abiertas/Sin atender, en el bucket
-- `snoozed`); al vencer (snoozedUntil<=now) reaparece como `open` de forma LAZY en los buckets
-- (sin cron). null = no pospuesta. Backfill: null (ninguna conversación existente está pospuesta).
ALTER TABLE "Conversation" ADD COLUMN "snoozedUntil" TIMESTAMP(3);

-- ─── 2. Índice sobre snoozedUntil ─────────────────────────────────────────────────
-- Sirve el filtro/count del bucket `snoozed` (vigentes) y el `listExpiredSnoozed` del watcher
-- (status='snoozed' AND snoozedUntil<=now). El planner lo combina con el filtro por status.
CREATE INDEX "Conversation_snoozedUntil_idx" ON "Conversation"("snoozedUntil");

-- ─── 3. Feature flag: snooze-reactivation (default OFF, dark by default) ───────────
-- El watcher SnoozeReactivationScheduler (ReactivateExpiredSnoozes) arranca DARK: lee este flag
-- EN CADA tick y, si está OFF, no procesa. Las VISTAS/COUNTS ya son correctos SIN el watcher
-- (derivación lazy en los buckets); el watcher sólo normaliza el status en DB (higiene) y deja
-- un evento 'unsnoozed' limpio. Sin este seed el flag NO existe en FeatureFlag y la UI no lo
-- muestra. Mismo patrón que 'radius-auto-cure' (20260917000100). Idempotente: ON CONFLICT DO NOTHING.
INSERT INTO "FeatureFlag" ("key", "enabled", "updatedAt")
VALUES ('snooze-reactivation', false, NOW())
ON CONFLICT DO NOTHING;
