import type { AccessPointRepository } from '@domain/ports/AccessPointRepository';
import type { AccessPointOptionDto } from '@application/dto/accessPoint.dto';

export interface ListAssignableAccessPointsQuery {
  networkSiteId?: string;
}

/**
 * contract-node-ap-auto-assign (Fase B, PICK-2) — catálogo de APs asignables a mano por el
 * picker manual. Filtra `missingSince !== null` (los retirados NO se listan como asignables —
 * pero un contrato YA asignado a uno no se rompe, Fase A FIX-2). Orden `name` asc.
 */
export class ListAssignableAccessPoints {
  constructor(private readonly accessPointRepo: AccessPointRepository) {}

  async execute(query: ListAssignableAccessPointsQuery): Promise<AccessPointOptionDto[]> {
    const all = query.networkSiteId
      ? await this.accessPointRepo.findByNetworkSiteId(query.networkSiteId)
      : await this.accessPointRepo.findMany();

    return all
      .filter((ap) => ap.missingSince === null)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((ap) => ({ id: ap.id, name: ap.name, mac: ap.mac, networkSiteId: ap.networkSiteId }));
  }
}
