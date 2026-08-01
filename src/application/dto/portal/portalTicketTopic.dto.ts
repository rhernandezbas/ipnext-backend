/**
 * PortalTicketTopicDto — portal-ticket-topic (BE).
 *
 * `GET /api/portal/ticket-topics` — el catálogo de tópicos que el cliente
 * puede elegir al abrir un reclamo (`POST /api/portal/tickets`, campo
 * `topicId`). SOLO expone las áreas `portalVisible = true` (ver
 * `TicketAreaCatalogRepository.listPortalVisible`) — NUNCA el `name` interno
 * del área, ni `color`, ni `portalVisible`: son detalles operativos del
 * catálogo admin, sin uso legítimo del lado del cliente.
 */
export interface PortalTicketTopicDto {
  id: string;
  /** `TicketAreaCatalog.portalLabel`, o `name` cuando el admin todavía no cargó un label. */
  label: string;
  description: string | null;
}
