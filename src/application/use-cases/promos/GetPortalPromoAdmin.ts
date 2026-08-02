import type { PortalPromoRepository } from '@domain/ports/PortalPromoRepository';
import type { PortalPromoAdminDto } from '@application/dto/promos.dto';
import { toPortalPromoAdminDto } from '@application/dto/promos.dto';
import { PortalPromoNotFoundError } from '@domain/errors/portalPromo.errors';

/** GetPortalPromoAdmin — admin, `GET /api/promos/:id`. Sin re-chequeo de
 * elegibilidad (a diferencia de `GetPortalPromo` client-facing) — el admin
 * puede ver cualquier promo, incluida una en borrador o archivada. */
export class GetPortalPromoAdmin {
  constructor(private readonly promos: Pick<PortalPromoRepository, 'findById'>) {}

  async execute(id: string): Promise<PortalPromoAdminDto> {
    const promo = await this.promos.findById(id);
    if (!promo) throw new PortalPromoNotFoundError(id);
    return toPortalPromoAdminDto(promo);
  }
}
