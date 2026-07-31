-- portal-ticket-messaging (v2.B) — mensajeria interna en los reclamos (cliente <-> staff).
--
-- TicketComment gana autoria (authorKind/authorId) y visibilidad (visibility). El
-- invariante central de la feature es que un comentario visibility=internal NUNCA
-- sale por /api/portal/* — se filtra en la query del repositorio (WHERE), nunca en
-- el mapper. Ver PrismaTicketCommentRepository.listPublicByTicket.
--
-- BACKFILL CONSERVADOR (obligatorio, spec "Backfill conservador de lo existente"):
-- TODOS los TicketComment preexistentes se marcan authorKind=staff + visibility=internal.
-- Esos comentarios los escribio el equipo cuando nadie imaginaba que un cliente los
-- leeria — publicarlos de golpe seria exponer años de notas internas de un dia para
-- el otro. El lado seguro es el silencio: cero comentarios historicos se vuelven
-- visibles para clientes por efecto de este cambio.
--
-- authorKind/visibility se agregan NULLABLE primero, se backfillean, y RECIEN
-- despues se marcan NOT NULL — la unica secuencia valida contra una tabla con filas
-- existentes (un NOT NULL directo sin default hubiera fallado contra cualquier
-- TicketComment ya persistido).

-- CreateEnum
CREATE TYPE "TicketCommentAuthorKind" AS ENUM ('client', 'staff');

-- CreateEnum
CREATE TYPE "TicketCommentVisibility" AS ENUM ('public', 'internal');

-- AlterTable: TicketComment — columnas nuevas, NULLABLE por ahora (backfill abajo).
--
-- F6 (fix wave): authorKind/visibility llevan DEFAULT desde el alta. NO es para
-- el backfill de abajo (que escribe TODAS las filas existentes explicitamente,
-- con o sin default) sino para la VENTANA de deploy: en el pipeline,
-- `migrate deploy` corre ANTES del swap del container — hasta que el codigo
-- nuevo esta activo, cualquier INSERT del codigo VIEJO (que no conoce estas
-- columnas) sigue funcionando porque el default resuelve el valor. Sin
-- DEFAULT, esa ventana revienta con NOT NULL violation y
-- POST /api/tickets/:id/comments queda en 500. 'staff'/'internal' es ademas
-- el lado SEGURO — mismo criterio que el backfill.
ALTER TABLE "TicketComment"
  ADD COLUMN "authorId" TEXT,
  ADD COLUMN "authorKind" "TicketCommentAuthorKind" DEFAULT 'staff',
  ADD COLUMN "visibility" "TicketCommentVisibility" DEFAULT 'internal';

-- Backfill conservador: TODO lo existente queda staff + internal (ver nota arriba).
-- COSTO (F6, fix wave): reescribe TODAS las filas de TicketComment (UPDATE sin
-- WHERE) dentro de la transaccion de la migracion — en una tabla grande esto
-- es una transaccion larga (ROW EXCLUSIVE por fila, no bloquea lecturas, pero
-- mantiene la migracion corriendo mas tiempo). Aceptado a proposito: la tabla
-- de comentarios de tickets no es de las mas grandes del sistema; si esto se
-- vuelve un problema en un futuro deploy, la alternativa es un backfill por
-- lotes FUERA de la migracion (patron messaging-bulk-*), pero eso complica el
-- rollout de un enum + NOT NULL en un solo paso.
UPDATE "TicketComment" SET "authorKind" = 'staff', "visibility" = 'internal';

-- Ahora que no quedan NULLs, se puede exigir NOT NULL en las dos columnas nuevas
-- (authorId se queda NULLABLE a proposito: es opcional incluso en altas nuevas).
ALTER TABLE "TicketComment"
  ALTER COLUMN "authorKind" SET NOT NULL,
  ALTER COLUMN "visibility" SET NOT NULL;

-- CreateIndex: sirve la query del invariante (WHERE ticketId = ? AND visibility = 'public')
-- sin escanear el hilo completo del ticket.
CREATE INDEX "TicketComment_ticketId_visibility_idx" ON "TicketComment"("ticketId", "visibility");

-- AlterTable: TicketCommentAttachment — adjuntos de la mensajeria nueva (foto/audio/
-- video), guardados en MinIO via el patron BE-proxy (storageKey), espejo de
-- NewsPostAttachment. `url` se vuelve NULLABLE: el sistema VIEJO de notas internas
-- (data-URI base64 en la columna, ver ticketComments.dto.ts) sigue usandolo tal cual;
-- los adjuntos nuevos usan storageKey en cambio. Aditivo, sin backfill: las filas
-- viejas quedan con storageKey/kind NULL y url poblado (sin cambios de dato).
ALTER TABLE "TicketCommentAttachment"
  ADD COLUMN "storageKey" TEXT,
  ADD COLUMN "kind" TEXT,
  ALTER COLUMN "url" DROP NOT NULL;

-- AlterTable: Ticket — cursor de lectura por lado ("no leidos"). NULLABLE, sin
-- backfill: NULL = "nunca abrio el hilo" es el estado correcto para TODO ticket
-- preexistente (nadie tenia un hilo de mensajeria que "leer" antes de esta migracion).
ALTER TABLE "Ticket"
  ADD COLUMN "clientMessagesReadAt" TIMESTAMP(3),
  ADD COLUMN "staffMessagesReadAt" TIMESTAMP(3);
