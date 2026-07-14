import type { CampaignRepository } from '@domain/ports/CampaignRepository';
import { toCampaignSummaryDto, type CampaignSummaryDto } from '@application/dto/messaging-bulk.dto';
import type { PaginatedResult, PaginatedQuery } from '@application/dto/pagination';
import { deriveLiveCounters, needsLiveCounters } from './deriveLiveCounters';

/**
 * messaging-bulk (F2, HIST-1) — historial paginado de campañas, ordenado por
 * `createdAt` descendente (más reciente primero) — orden ya resuelto por
 * `CampaignRepository.list`.
 *
 * ── fix wave 3 (FIX-6-v2): la lista no debe mostrar 0 durante el envío ────────
 * `list` devuelve el snapshot del header, cuyos contadores solo se escriben en
 * `SendCampaign.finalize` (0 hasta el cierre). Mientras `GetCampaign` (detalle)
 * ya los deriva EN VIVO (FIX-6), la lista mostraba 0/total durante un envío →
 * detalle y lista DIVERGÍAN. Acá se derivan en vivo los contadores de las
 * campañas EN VUELO (`running`/`paused`), consistente con `GetCampaign`, vía el
 * helper compartido `deriveLiveCounters`. Tradeoff (ver `needsLiveCounters`):
 * SOLO las in-flight gatillan las 4 queries de conteo — las terminales confían
 * en el snapshot de `finalize` (idéntico a la derivación) y `pending` es 0. El
 * lock GLOBAL de envío acota las in-flight a ~1, así que NO es un N+1 sobre la
 * página de historial.
 *
 * Gate RBAC `messaging.bulk` se aplica en la ruta (Batch 7), no acá.
 */
export class ListCampaigns {
  constructor(private readonly campaignRepo: CampaignRepository) {}

  async execute(query: PaginatedQuery): Promise<PaginatedResult<CampaignSummaryDto>> {
    const page = await this.campaignRepo.list(query);
    const data = await Promise.all(
      page.data.map(async (campaign) => {
        if (!needsLiveCounters(campaign.status)) return toCampaignSummaryDto(campaign);
        const counters = await deriveLiveCounters(this.campaignRepo, campaign.id);
        return toCampaignSummaryDto({ ...campaign, ...counters });
      }),
    );
    return {
      data,
      total: page.total,
      page: page.page,
      limit: page.limit,
    };
  }
}
