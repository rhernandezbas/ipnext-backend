import type { PortalPromoRepository, CreatePortalPromoData } from '@domain/ports/PortalPromoRepository';
import type { PortalPromoAdminDto } from '@application/dto/promos.dto';
import { toPortalPromoAdminDto } from '@application/dto/promos.dto';
import { PortalPromoValidationError } from '@domain/errors/portalPromo.errors';

export interface CreatePortalPromoInput {
  title: string;
  summary: string;
  body: string;
  imageStorageKey?: string | null;
  ctaLabel?: string;
  ticketAreaId?: string | null;
  segment: CreatePortalPromoData['segment'];
  startsAt: Date;
  endsAt: Date;
  publishedAt?: Date | null;
}

/** CreatePortalPromo — admin, `POST /api/promos`. `authorId`/`authorName` se
 * estampan desde la sesión (mismo criterio que `NewsPost.authorId/Name`). */
export class CreatePortalPromo {
  constructor(private readonly promos: PortalPromoRepository) {}

  async execute(input: CreatePortalPromoInput, authorId: string | null, authorName: string): Promise<PortalPromoAdminDto> {
    if (input.endsAt.getTime() < input.startsAt.getTime()) {
      throw new PortalPromoValidationError('endsAt debe ser posterior o igual a startsAt');
    }
    const promo = await this.promos.create({ ...input, authorId, authorName });
    return toPortalPromoAdminDto(promo);
  }
}
