import type { TicketAreaCatalogRepository } from '@domain/ports/TicketAreaCatalogRepository';
import type { PortalTicketTopicDto } from '@application/dto/portal/portalTicketTopic.dto';

/**
 * ListPortalTicketTopics — portal-ticket-topic (BE).
 *
 * El cliente ELIGE un tópico al abrir un reclamo (en vez de que el área salga
 * siempre del config, `config.portal.ticketAreaName`). Expone SOLO las áreas
 * marcadas `portalVisible = true` en el catálogo — NOC y GigaRed son áreas
 * INTERNAS y jamás deben aparecer acá; el filtro vive DENTRO del WHERE del
 * adapter (`TicketAreaCatalogRepository.listPortalVisible`), no en un
 * `.filter()` de esta capa.
 *
 * `label` cae a `name` cuando `portalLabel` es null (el área todavía no tiene
 * un nombre pensado para el cliente). NUNCA expone `name` interno, `color` ni
 * `portalVisible` — ver `PortalTicketTopicDto`.
 */
export class ListPortalTicketTopics {
  constructor(private readonly areas: TicketAreaCatalogRepository) {}

  async execute(): Promise<PortalTicketTopicDto[]> {
    const visible = await this.areas.listPortalVisible();
    return visible.map((area) => ({
      id: area.id,
      label: area.portalLabel ?? area.name,
      description: area.portalDescription ?? null,
    }));
  }
}
