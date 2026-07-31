-- portal-ticket-messaging (v2.B) fix wave FINAL, G5 — DROP DEFAULT de seguimiento.
--
-- El DEFAULT de authorKind/visibility (F6, ver
-- 20261029000000_ticket_messaging) SOLO existia para la VENTANA de deploy:
-- entre que `migrate deploy` corre y el swap del container termina, el
-- codigo VIEJO (que no conoce estas columnas) podia seguir insertando
-- TicketComment sin especificarlas. Sin DEFAULT en esa ventana, esos INSERT
-- revientan con NOT NULL violation.
--
-- Una vez que el swap completo y el codigo NUEVO esta activo (SIEMPRE
-- estampa authorKind/visibility explicitamente — ver AddTicketComment,
-- SendStaffTicketReply, SendPortalTicketMessage), el DEFAULT deja de
-- proteger nada y pasa a ser un peligro PERMANENTE: con @default en el
-- schema de Prisma, authorKind/visibility quedan OPCIONALES para siempre en
-- el input de `create` — un `create` futuro que se olvide de pasar
-- authorKind compila igual y estampa 'staff' en silencio, lo cual puede
-- esconder un mensaje del CLIENTE mal-etiquetado como staff (no cuenta en
-- countUnread, se muestra como si lo hubiera escrito soporte).
--
-- IMPORTANTE — orden de aplicacion: esta migracion se aplica DESPUES de que
-- el swap de deploy de 20261029000000_ticket_messaging haya terminado (el
-- codigo nuevo, que ya estampa ambos campos siempre, tiene que estar
-- corriendo en TODAS las instancias primero). Aplicarla en el MISMO release
-- que la migracion original reabre exactamente la ventana que el DEFAULT
-- original protegia.
ALTER TABLE "TicketComment"
  ALTER COLUMN "authorKind" DROP DEFAULT,
  ALTER COLUMN "visibility" DROP DEFAULT;
