import type { PortalPromoRepository } from '@domain/ports/PortalPromoRepository';
import type { PortalPromoResponseRepository } from '@domain/ports/PortalPromoResponseRepository';
import type { SegmentMembershipChecker } from '@domain/ports/CustomerRepository';
import type { PortalPromoDetailDto } from '@application/dto/portal/portalPromo.dto';
import { toPortalPromoDetailDto } from '@application/dto/portal/portalPromo.dto';
import { isPortalPromoEligibleNow } from './portalPromoEligibility';

/**
 * GetPortalPromo — portal-promos, `GET /api/portal/promos/:id`.
 *
 * spec: "Re-chequea TODAS las condiciones de arriba" (las de la lista) —
 * NUNCA confía en que el cliente solo pida el `id` de una promo que YA vio en
 * `GET /promos`. Una promo que no le aplica a este cliente (borrador,
 * archivada, fuera de ventana, otro segmento, o YA respondida) da `null`
 * (⇒ 404 en la ruta) — nunca revela su contenido.
 */
export class GetPortalPromo {
  constructor(
    private readonly promos: Pick<PortalPromoRepository, 'findById'>,
    private readonly responses: Pick<PortalPromoResponseRepository, 'findByPromoAndClient'>,
    private readonly segmentChecker: Pick<SegmentMembershipChecker, 'clientMatchesSegment'>,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(clientId: string, promoId: string): Promise<PortalPromoDetailDto | null> {
    const promo = await this.promos.findById(promoId);
    if (!promo) return null;
    if (!isPortalPromoEligibleNow(promo, this.clock())) return null;

    const responded = await this.responses.findByPromoAndClient(promoId, clientId);
    if (responded) return null;

    const matches = await this.segmentChecker.clientMatchesSegment(clientId, promo.segment);
    if (!matches) return null;

    return toPortalPromoDetailDto(promo);
  }
}
