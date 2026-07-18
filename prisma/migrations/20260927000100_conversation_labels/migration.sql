-- conversation-labels (Ola 5) — catálogo de etiquetas de color por conversación + join N:M.
-- Aditiva: 2 CREATE TABLE (ConversationLabel + ConversationLabelAssignment) + índices + FKs
-- (Cascade en ambos lados de la join), sin DROP ni backfill.
-- Seed de 4 labels default idempotente (ON CONFLICT ("name") DO NOTHING).
-- El permiso RBAC messaging.manage (gate del CRUD) YA está seedeado y otorgado por
-- 20260926000000_internal_notes_edit — no se re-seedea acá.
-- No BEGIN/COMMIT (Prisma envuelve cada migración en su propia transacción).

-- CreateTable
CREATE TABLE "ConversationLabel" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#6366f1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationLabel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationLabelAssignment" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "labelId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationLabelAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConversationLabel_name_key" ON "ConversationLabel"("name");

-- CreateIndex
CREATE INDEX "ConversationLabelAssignment_conversationId_idx" ON "ConversationLabelAssignment"("conversationId");

-- CreateIndex
CREATE INDEX "ConversationLabelAssignment_labelId_idx" ON "ConversationLabelAssignment"("labelId");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationLabelAssignment_conversationId_labelId_key" ON "ConversationLabelAssignment"("conversationId", "labelId");

-- AddForeignKey
ALTER TABLE "ConversationLabelAssignment" ADD CONSTRAINT "ConversationLabelAssignment_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationLabelAssignment" ADD CONSTRAINT "ConversationLabelAssignment_labelId_fkey" FOREIGN KEY ("labelId") REFERENCES "ConversationLabel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Seed: 4 labels default (idempotente — ON CONFLICT ("name") DO NOTHING) ────────────────────
-- Colores = tokens del design system (Tailwind/shadcn slate scale del proyecto):
--   Urgente     → #ef4444  (red-500     · token --color-danger)
--   Reclamo     → #f59e0b  (amber-500   · token --color-warning)
--   Ventas      → #22c55e  (green-500   · token --color-success)
--   Seguimiento → #6366f1  (indigo-500  · token --color-primary, el default del catálogo)
INSERT INTO "ConversationLabel" ("id", "name", "color", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(), 'Urgente',     '#ef4444', NOW(), NOW()),
  (gen_random_uuid(), 'Reclamo',     '#f59e0b', NOW(), NOW()),
  (gen_random_uuid(), 'Ventas',      '#22c55e', NOW(), NOW()),
  (gen_random_uuid(), 'Seguimiento', '#6366f1', NOW(), NOW())
ON CONFLICT ("name") DO NOTHING;
