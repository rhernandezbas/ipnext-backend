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

/**
 * portal-ticket-contract (v2.A) — "para abrir un reclamo debería seleccionar
 * el contrato primero". `contractId` viaja porque YA está justificado (es el
 * mismo id que `/api/portal/plans` expone para el selector — ver
 * `portalPlan.dto.ts`); `contractLabel` es el campo LEGIBLE elegido para que
 * la app muestre "Reclamo sobre: <contractLabel>" sin tener que resolver el
 * id contra `/plans` de nuevo. Se eligió `Contract.plan` (p.ej. "50 Mb
 * Simetrico") en vez de `Contract.address` o `Contract.name`: es el mismo
 * texto que YA ve el cliente en "Mis planes" (`PortalPlanDto.plan`) — mismo
 * vocabulario en toda la app, y a diferencia de `address` no es PII de
 * ubicación. `null` cuando el ticket no tiene contrato asociado (cliente sin
 * contratos, o tickets viejos pre-v2.A).
 */
export interface PortalTicketDetailDto extends PortalTicketListItemDto {
  description: string;
  contractId: string | null;
  contractLabel: string | null;
}
