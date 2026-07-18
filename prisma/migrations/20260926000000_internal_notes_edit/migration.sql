-- Migration: 20260926000000_internal_notes_edit
-- messaging-inbox-notes (edit/delete) — atribución de autor + editar/eliminar
-- (autor+supervisor, soft-delete) + contador de notas internas por conversación.
--
-- 100% ADITIVA: sólo ADD COLUMN nullable / ADD COLUMN con DEFAULT / CREATE INDEX /
-- ADD FK ON DELETE SET NULL, más un backfill best-effort del contador (sin guard
-- defensivo que aborte) y el seed idempotente del permiso messaging.manage. Sin BEGIN/
-- COMMIT explícito (Prisma envuelve cada migración en su propia transacción).

-- ─── 1. ChatMessage: authorId + editedAt + deletedAt (aditivas, nullable) ────────
-- authorId: FK soft al usuario RBAC autor de la nota (SetNull → borrar el usuario NO
--   borra sus notas). NULL en TODAS las filas históricas y en los mensajes públicos.
-- editedAt: última edición de contenido (NULL = nunca editada → DTO edited=false).
-- deletedAt: soft-delete (NULL = viva → DTO deleted=false). La fila nunca se borra.
ALTER TABLE "ChatMessage" ADD COLUMN "authorId" TEXT;
ALTER TABLE "ChatMessage" ADD COLUMN "editedAt" TIMESTAMP(3);
ALTER TABLE "ChatMessage" ADD COLUMN "deletedAt" TIMESTAMP(3);

-- ─── 2. Conversation: internalNoteCount desnormalizado (aditiva, default 0) ───────
ALTER TABLE "Conversation" ADD COLUMN "internalNoteCount" INTEGER NOT NULL DEFAULT 0;

-- ─── 3. FK authorId → RbacUser (ON DELETE SET NULL, preserva la nota) ─────────────
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "RbacUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── 4. Índices (autor + count de notas vivas por conversación) ───────────────────
CREATE INDEX "ChatMessage_authorId_idx" ON "ChatMessage"("authorId");
CREATE INDEX "ChatMessage_conversationId_isPrivate_idx" ON "ChatMessage"("conversationId", "isPrivate");

-- ─── 5. Backfill best-effort del contador (COUNT de notas internas vivas) ─────────
-- Notas ya existentes: isPrivate=true AND deletedAt IS NULL (recién creada, todas vivas).
-- Sin guard defensivo que aborte: si no hay ninguna, el default 0 ya deja el estado correcto.
UPDATE "Conversation" c
SET "internalNoteCount" = (
  SELECT COUNT(*)
  FROM "ChatMessage" m
  WHERE m."conversationId" = c."id"
    AND m."isPrivate" = true
    AND m."deletedAt" IS NULL
);

-- ─── 6. Permiso messaging.manage (el "supervisor") — seed idempotente ─────────────
-- El SUPERVISOR de notas internas = quien tiene messaging.manage. Otorgado a
-- super_admin (redundante: el middleware ya hace short-circuit por rol, pero se
-- siembra por consistencia con messaging.bulk/templates) + administrador.
-- Molde EXACTO de 20260908000100_messaging_bulk_permissions. La acción 'manage' y el
-- módulo 'messaging' YA existen en KNOWN_ACTIONS/RBAC_MODULES — acá sólo se crea la
-- fila de permiso (module,'manage') y sus grants. Idempotente: ON CONFLICT DO NOTHING.

-- 6a. Re-seed defensivo del módulo messaging (fresh-DB safety net).
INSERT INTO "RbacModule" ("id", "code", "label")
VALUES (gen_random_uuid(), 'messaging', 'Mensajería')
ON CONFLICT ("code") DO NOTHING;

-- 6b. Seed del permiso messaging.manage.
INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'manage'
FROM "RbacModule" m
WHERE m."code" = 'messaging'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- 6c. Grant messaging.manage → super_admin.
INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'super_admin'
  AND m."code" = 'messaging'
  AND p."action" = 'manage'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- 6d. Grant messaging.manage → administrador (el "supervisor").
INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'administrador'
  AND m."code" = 'messaging'
  AND p."action" = 'manage'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
