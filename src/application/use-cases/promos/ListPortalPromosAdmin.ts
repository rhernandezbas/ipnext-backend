import type { PortalPromoRepository } from '@domain/ports/PortalPromoRepository';
import type { PortalPromoAdminDto } from '@application/dto/promos.dto';
import { toPortalPromoAdminDto } from '@application/dto/promos.dto';

/** ListPortalPromosAdmin — admin, `GET /api/promos`. TODAS las promos
 * (borrador/publicada/archivada) — a diferencia del listado client-facing,
 * que solo muestra las vigentes y aplicables. */
export class ListPortalPromosAdmin {
  constructor(private readonly promos: Pick<PortalPromoRepository, 'list'>) {}

  async execute(): Promise<PortalPromoAdminDto[]> {
    const all = await this.promos.list();
    return all.map(toPortalPromoAdminDto);
  }
}
