import type { CampaignRepository } from '@domain/ports/CampaignRepository';
import type { CampaignRecipientStatus } from '@domain/entities/campaign';
import { CampaignNotFoundError } from '@domain/errors/messaging-bulk';
import {
  toCampaignDto,
  toCampaignRecipientDto,
  type CampaignDto,
  type CampaignRecipientDto,
} from '@application/dto/messaging-bulk.dto';
import type { PaginatedResult } from '@application/dto/pagination';
import { deriveLiveCounters } from './deriveLiveCounters';

export interface GetCampaignInput {
  campaignId: string;
  /** Si es falsy, `recipients` no viene en el output (evita el costo de paginar). */
  includeRecipients?: boolean;
  page?: number;
  limit?: number;
  status?: CampaignRecipientStatus;
}

export interface GetCampaignOutput {
  campaign: CampaignDto;
  recipients?: PaginatedResult<CampaignRecipientDto>;
}

/**
 * messaging-bulk (F2, HIST-2/HIST-3) — header de la campaña + una página de
 * `CampaignRecipient` opcional, filtrable por status, poleable durante el
 * envío (progreso en vivo) y consultable después (auditoría).
 *
 * ── fix wave (FIX-6): contadores EN VIVO ────────────────────────────────────
 * Los contadores del header (`sentCount`/`failedCount`/…) se escriben SOLO en
 * `SendCampaign.finalize` (al cierre). Un FE que pollea el detalle durante el
 * envío veía 0/total hasta que la campaña quedaba `done` (viola HIST-2
 * "progreso en vivo"). Acá se DERIVAN los contadores en vivo de los counts
 * reales por-status del repo (`listRecipients(...).total`), igual que
 * `finalize`, así el polling refleja el avance real en cada consulta.
 *
 * Gate RBAC `messaging.bulk` se aplica en la ruta (Batch 7), no acá.
 */
export class GetCampaign {
  constructor(private readonly campaignRepo: CampaignRepository) {}

  async execute(input: GetCampaignInput): Promise<GetCampaignOutput> {
    const campaign = await this.campaignRepo.findById(input.campaignId);
    if (!campaign) {
      throw new CampaignNotFoundError(input.campaignId);
    }

    // FIX-6 — contadores por-status REALES (no el snapshot del header, que solo
    // se escribe en finalize). Vía el helper compartido con `ListCampaigns`
    // (FIX-6-v2) para que detalle y lista deriven IDÉNTICO. El detalle siempre
    // deriva (una sola campaña, costo trivial); la lista solo las in-flight.
    const counters = await deriveLiveCounters(this.campaignRepo, input.campaignId);

    const output: GetCampaignOutput = {
      campaign: {
        ...toCampaignDto(campaign),
        ...counters,
      },
    };

    if (input.includeRecipients) {
      const page = await this.campaignRepo.listRecipients(input.campaignId, {
        statusIn: input.status ? [input.status] : undefined,
        page: input.page,
        limit: input.limit,
      });
      output.recipients = {
        data: page.data.map(toCampaignRecipientDto),
        total: page.total,
        page: page.page,
        limit: page.limit,
      };
    }

    return output;
  }
}
