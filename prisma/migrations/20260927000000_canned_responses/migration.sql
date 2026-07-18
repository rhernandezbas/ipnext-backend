-- Migration: 20260927000000_canned_responses
-- Ola 4 (inbox-Chatwoot) — respuestas rápidas / macros (canned responses).
-- 100% ADITIVA: nueva tabla CannedResponse (shortcut UNIQUE = índice de búsqueda por
-- shortcut) + FK opcional al autor (ON DELETE SET NULL: borrar el usuario NO borra la
-- respuesta, sólo desasocia). Sin backfill. Reusa los permisos messaging.read /
-- messaging.manage YA sembrados (20260926000000_internal_notes_edit) — no siembra nada.
-- No explicit transaction block (Prisma wraps each migration in its own transaction).

-- CreateTable
CREATE TABLE "CannedResponse" (
    "id" TEXT NOT NULL,
    "shortcut" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CannedResponse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CannedResponse_shortcut_key" ON "CannedResponse"("shortcut");

-- AddForeignKey
ALTER TABLE "CannedResponse" ADD CONSTRAINT "CannedResponse_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "RbacUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
