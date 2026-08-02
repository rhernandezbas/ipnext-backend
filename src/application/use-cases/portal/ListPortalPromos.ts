import type { PortalPromoRepository } from '@domain/ports/PortalPromoRepository';
import type { PortalPromoResponseRepository } from '@domain/ports/PortalPromoResponseRepository';
import type { SegmentMembershipChecker } from '@domain/ports/CustomerRepository';
import type { PortalPromoSummaryDto } from '@application/dto/portal/portalPromo.dto';
import { toPortalPromoSummaryDto } from '@application/dto/portal/portalPromo.dto';

/**
 * ListPortalPromos — portal-promos, `GET /api/portal/promos`.
 *
 * Inversión deliberada (design §2): en vez de "¿qué clientes matchean este
 * segmento?" (que listaría potencialmente miles de filas por cada apertura de
 * la app), esto itera sobre las PROMOS activas (pocas decenas, acotado por
 * `PortalPromoRepository.listActive`) y para cada una pregunta "¿ESTE cliente
 * matchea?" vía `SegmentMembershipChecker.clientMatchesSegment` — la misma
 * pregunta narrow que ya resuelve UNA query dirigida.
 *
 * Orden de los 3 filtros (tiempo/publicación → respondidas → segmento):
 * `listActive` ya filtra publishedAt/archivedAt/ventana en la DB (barato);
 * "ya respondió" se resuelve con UNA query batch (`listRespondedPromoIds`,
 * nunca N+1); el chequeo de segmento es el más caro (una query por promo
 * candidata) así que corre ÚLTIMO, sobre el conjunto ya reducido.
 */
export class ListPortalPromos {
  constructor(
    private readonly promos: Pick<PortalPromoRepository, 'listActive'>,
    private readonly responses: Pick<PortalPromoResponseRepository, 'listRespondedPromoIds'>,
    private readonly segmentChecker: Pick<SegmentMembershipChecker, 'clientMatchesSegment'>,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(clientId: string): Promise<PortalPromoSummaryDto[]> {
    const now = this.clock();
    const active = await this.promos.listActive(now);
    if (active.length === 0) return [];

    const respondedIds = new Set(await this.responses.listRespondedPromoIds(clientId));
    const candidates = active.filter((p) => !respondedIds.has(p.id));

    const visible = [];
    for (const promo of candidates) {
      const matches = await this.segmentChecker.clientMatchesSegment(clientId, promo.segment);
      if (matches) visible.push(promo);
    }

    // Orden `publishedAt` desc (siempre no-null en el conjunto activo).
    visible.sort((a, b) => (a.publishedAt! < b.publishedAt! ? 1 : -1));
    return visible.map(toPortalPromoSummaryDto);
  }
}
