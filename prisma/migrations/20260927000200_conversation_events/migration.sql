-- Migration: 20260927000200_conversation_events
-- conversation-events (Ola 2, EPIC inbox-Chatwoot) — cimiento de los reports:
-- tabla ConversationEvent (historial append-only de transiciones) + Conversation.resolvedAt/
-- firstResolvedAt (timestamps derivados del ciclo de resolución).
--
-- 100% ADITIVA y de bajo riesgo: CREATE TABLE + ADD COLUMN nullable + CREATE INDEX + ADD FK
-- ON DELETE (Cascade/SetNull), más un backfill best-effort del estado derivado de las
-- conversaciones YA resueltas. Sin BEGIN/COMMIT explícito (Prisma envuelve cada migración
-- en su propia transacción).

-- ─── 1. Conversation: resolvedAt + firstResolvedAt (aditivas, nullable) ───────────
-- resolvedAt: ÚLTIMA resolución; se LIMPIA a null al reabrir (refleja el estado ACTUAL).
-- firstResolvedAt: PRIMERA resolución; NUNCA se limpia ("tiempo hasta primera resolución").
ALTER TABLE "Conversation" ADD COLUMN "resolvedAt" TIMESTAMP(3);
ALTER TABLE "Conversation" ADD COLUMN "firstResolvedAt" TIMESTAMP(3);

-- ─── 2. ConversationEvent: historial append-only de transiciones ──────────────────
CREATE TABLE "ConversationEvent" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actorId" TEXT,
    "fromValue" TEXT,
    "toValue" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationEvent_pkey" PRIMARY KEY ("id")
);

-- ─── 3. Índices (por conversación, por type+rango, por rango, por actor) ──────────
CREATE INDEX "ConversationEvent_conversationId_idx" ON "ConversationEvent"("conversationId");
CREATE INDEX "ConversationEvent_type_createdAt_idx" ON "ConversationEvent"("type", "createdAt");
CREATE INDEX "ConversationEvent_createdAt_idx" ON "ConversationEvent"("createdAt");
CREATE INDEX "ConversationEvent_actorId_idx" ON "ConversationEvent"("actorId");

-- ─── 4. FKs (conversación Cascade — borrar la conversación borra su historial;
--          actor SetNull — borrar el usuario preserva el historial desasociado) ────
ALTER TABLE "ConversationEvent" ADD CONSTRAINT "ConversationEvent_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationEvent" ADD CONSTRAINT "ConversationEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "RbacUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── 5. Backfill best-effort del estado derivado de las conversaciones YA resueltas ─
-- Para toda conversación con status='resolved', se aproxima resolvedAt = firstResolvedAt =
-- updatedAt. Es la MEJOR señal disponible para las históricas: NO existió tabla de eventos
-- hasta esta migración, así que la fecha exacta de resolución de las viejas es DESCONOCIDA
-- (updatedAt es lo más cercano — la última escritura del mirror, típicamente el resolve).
-- DELIBERADAMENTE NO se inventan filas en ConversationEvent para las históricas (no hay
-- data que respalde un 'resolved' con fecha real). Sólo se deriva el estado. Set-based,
-- idempotente, best-effort: SIN guard que aborte el deploy.
UPDATE "Conversation"
SET "resolvedAt" = "updatedAt",
    "firstResolvedAt" = "updatedAt"
WHERE "status" = 'resolved';
