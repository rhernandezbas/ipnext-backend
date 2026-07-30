/**
 * PortalTicketDto — customer-portal-api (Fase 5, task 5.1).
 *
 * portal-self-service spec "Mis tickets — ver y crear": `number` es
 * `Ticket.sequenceNumber` (el mismo "#N" que usa el admin — nunca el `id` UUID
 * interno). `status` es el string del catalogo (`Ticket.status`, ya resuelto por
 * el repo — nunca el id del catalogo). El detalle (`PortalTicketDetailDto`) NO
 * incluye `comments`: `TicketComment` (prisma/schema.prisma) no distingue
 * publico/interno (no hay columna `internal`/`visibility`), asi que exponer
 * CUALQUIER comentario del staff arriesgaria filtrar notas internas — fuera de
 * alcance de este spec ("comentarios de tickets de staff (internos)"). Si el
 * portal necesita comentarios en una fase futura, requiere primero una columna
 * de visibilidad en `TicketComment` (fuera de este change).
 */
export interface PortalTicketListItemDto {
  number: number;
  subject: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface PortalTicketDetailDto extends PortalTicketListItemDto {
  description: string;
}
