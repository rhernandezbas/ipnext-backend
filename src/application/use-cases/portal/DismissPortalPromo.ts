import type { PortalPromoRepository } from '@domain/ports/PortalPromoRepository';
import type { PortalPromoResponseRepository } from '@domain/ports/PortalPromoResponseRepository';
import type { SegmentMembershipChecker } from '@domain/ports/CustomerRepository';
import { isPortalPromoEligibleNow } from './portalPromoEligibility';

/**
 * DismissPortalPromo — portal-promos, `POST /api/portal/promos/:id/dismiss`.
 *
 * Registra `kind='dismissed'` — la promo deja de aparecer en `GET /promos`
 * (mismo filtro "no respondió antes" que excluye las `interested`). Idempotente:
 * si el cliente YA respondió (cualquiera de los dos kinds), es un no-op exitoso
 * — no hay nada más que "descartar".
 *
 * Devuelve `false` cuando la promo no existe o no le aplica a este cliente
 * (borrador/archivada/fuera de ventana/otro segmento) — la ruta responde 404.
 * `true` en cualquier otro caso (dismiss nuevo O ya respondida) — la ruta
 * responde 204.
 */
export class DismissPortalPromo {
  constructor(
    private readonly promos: Pick<PortalPromoRepository, 'findById'>,
    private readonly responses: Pick<PortalPromoResponseRepository, 'findByPromoAndClient' | 'create'>,
    private readonly segmentChecker: Pick<SegmentMembershipChecker, 'clientMatchesSegment'>,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(clientId: string, promoId: string): Promise<boolean> {
    const promo = await this.promos.findById(promoId);
    if (!promo) return false;

    const existing = await this.responses.findByPromoAndClient(promoId, clientId);
    if (existing) return true; // ya respondida — no-op idempotente.

    if (!isPortalPromoEligibleNow(promo, this.clock())) return false;
    const matches = await this.segmentChecker.clientMatchesSegment(clientId, promo.segment);
    if (!matches) return false;

    await this.responses.create({ promoId, clientId, kind: 'dismissed' });
    return true;
  }
}
