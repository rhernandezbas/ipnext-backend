import type { PortalPromoRepository, UpdatePortalPromoData } from '@domain/ports/PortalPromoRepository';
import type { PortalPromoAdminDto } from '@application/dto/promos.dto';
import { toPortalPromoAdminDto } from '@application/dto/promos.dto';
import { PortalPromoNotFoundError, PortalPromoValidationError } from '@domain/errors/portalPromo.errors';

/** UpdatePortalPromo — admin, `PATCH /api/promos/:id`. Partial update; ver
 * `UpdatePortalPromoData` para el contrato undefined/null de publishedAt/archivedAt. */
export class UpdatePortalPromo {
  constructor(private readonly promos: PortalPromoRepository) {}

  async execute(id: string, patch: UpdatePortalPromoData): Promise<PortalPromoAdminDto> {
    if (patch.startsAt !== undefined && patch.endsAt !== undefined && patch.endsAt.getTime() < patch.startsAt.getTime()) {
      throw new PortalPromoValidationError('endsAt debe ser posterior o igual a startsAt');
    }
    const updated = await this.promos.update(id, patch);
    if (!updated) throw new PortalPromoNotFoundError(id);
    return toPortalPromoAdminDto(updated);
  }
}
