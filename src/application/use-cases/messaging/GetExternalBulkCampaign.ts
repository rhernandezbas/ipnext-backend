import type { CampaignRepository } from '@domain/ports/CampaignRepository';
import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import type { CampaignStatus } from '@domain/entities/campaign';
import { CampaignNotFoundError } from '@domain/errors/messaging-bulk';
import { deriveLiveCounters } from './deriveLiveCounters';
import { API_MESSAGING_USER_LOGIN } from '@domain/constants/machineUsers';

export interface GetExternalBulkCampaignInput {
  campaignId: string;
}

/** D12 — shape EXACTO del status de campaña para el polling M2M (STATUS-1). */
export interface GetExternalBulkCampaignOutput {
  campaignId: string;
  status: CampaignStatus;
  total: number;
  sentCount: number;
  failedCount: number;
  skippedCount: number;
  optedOutCount: number;
  startedAt: string | null;
  finishedAt: string | null;
}

/**
 * external-bulk-messaging (Batch 3, STATUS-1) — lectura de estado ACOTADA a
 * campañas propias del caller M2M (`createdById === api-messaging`). Cualquier
 * otra campaña (creada desde la UI admin) responde `CampaignNotFoundError` —
 * NUNCA revela que existe (mismo criterio que `GetCampaign`/RBAC de otros
 * dominios: un 403 filtraría existencia, un 404 no).
 */
export class GetExternalBulkCampaign {
  constructor(
    private readonly campaignRepo: CampaignRepository,
    private readonly rbacUserRepo: RbacUserRepository,
  ) {}

  async execute(input: GetExternalBulkCampaignInput): Promise<GetExternalBulkCampaignOutput> {
    const campaign = await this.campaignRepo.findById(input.campaignId);
    if (!campaign) {
      throw new CampaignNotFoundError(input.campaignId);
    }

    const apiUser = await this.rbacUserRepo.findByLogin(API_MESSAGING_USER_LOGIN);
    if (!apiUser || campaign.createdById !== apiUser.id) {
      // STATUS-1 — "no revela existencia": misma respuesta que un id inexistente.
      throw new CampaignNotFoundError(input.campaignId);
    }

    const counters = await deriveLiveCounters(this.campaignRepo, campaign.id);

    return {
      campaignId: campaign.id,
      status: campaign.status,
      total: campaign.total,
      ...counters,
      startedAt: campaign.startedAt,
      finishedAt: campaign.finishedAt,
    };
  }
}
