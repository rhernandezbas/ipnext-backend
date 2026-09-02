/**
 * external-bulk-messaging (Batch 3, task 3.4) — `GetExternalBulkCampaign`.
 * STATUS-1: lectura de estado ACOTADA a campañas propias del caller M2M
 * (`createdById === api-messaging`); cualquier otra campaña responde 404 (no
 * revela existencia).
 */
import { GetExternalBulkCampaign } from '@application/use-cases/messaging/GetExternalBulkCampaign';
import { InMemoryCampaignRepository } from '@infrastructure/adapters/in-memory/InMemoryCampaignRepository';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { bootstrapApiMessagingUser } from '@infrastructure/bootstrap/bootstrapApiMessagingUser';
import { CampaignNotFoundError } from '@domain/errors/messaging-bulk';

async function setup() {
  const campaignRepo = new InMemoryCampaignRepository();
  const rbacUserRepo = new InMemoryRbacUserRepository();
  const bootstrap = await bootstrapApiMessagingUser(rbacUserRepo, { passwordHash: 'unusable-hash' });
  const useCase = new GetExternalBulkCampaign(campaignRepo, rbacUserRepo);
  return { useCase, campaignRepo, rbacUserRepo, apiMessagingUserId: bootstrap.id };
}

describe('GetExternalBulkCampaign (STATUS-1)', () => {
  it('campaña propia (createdById = api-messaging) → 200 con el DTO de estado', async () => {
    const { useCase, campaignRepo, apiMessagingUserId } = await setup();
    const campaign = await campaignRepo.create({
      name: 'external-bulk:promo',
      templateRef: 'HXtest',
      segment: { statuses: [] },
      variableSpec: {},
      total: 3,
      createdById: apiMessagingUserId,
    });
    const [r1, r2, r3] = await campaignRepo.bulkCreateRecipients(campaign.id, [
      { clientId: null, contactName: 'A', phoneNormalized: '1', phoneE164: '+5491' },
      { clientId: null, contactName: 'B', phoneNormalized: '2', phoneE164: '+5492' },
      { clientId: null, contactName: 'C', phoneNormalized: '3', phoneE164: '+5493' },
    ]);
    await campaignRepo.updateRecipient(r1!.id, { status: 'sent', sentAt: new Date().toISOString() });
    await campaignRepo.updateRecipient(r2!.id, { status: 'failed', error: 'boom' });
    await campaignRepo.updateRecipient(r3!.id, { status: 'opted_out' });

    const result = await useCase.execute({ campaignId: campaign.id });

    expect(result).toEqual({
      campaignId: campaign.id,
      status: 'pending',
      total: 3,
      sentCount: 1,
      failedCount: 1,
      skippedCount: 0,
      optedOutCount: 1,
      startedAt: null,
      finishedAt: null,
    });
  });

  it('campaña de la UI admin (createdById distinto) → CampaignNotFoundError (404, no revela existencia)', async () => {
    const { useCase, campaignRepo } = await setup();
    const campaign = await campaignRepo.create({
      name: 'Campaña admin',
      templateRef: 'HXtest',
      segment: { statuses: ['late'] },
      variableSpec: {},
      total: 1,
      createdById: 'admin-user-1',
    });

    await expect(useCase.execute({ campaignId: campaign.id })).rejects.toThrow(CampaignNotFoundError);
  });

  it('campaignId inexistente → CampaignNotFoundError (404)', async () => {
    const { useCase } = await setup();

    await expect(useCase.execute({ campaignId: 'nope' })).rejects.toThrow(CampaignNotFoundError);
  });

  it('api-messaging NO bootstrapeado (usuario ausente) → CampaignNotFoundError (nunca revela ni crashea distinto a 404)', async () => {
    const campaignRepo = new InMemoryCampaignRepository();
    const rbacUserRepo = new InMemoryRbacUserRepository(); // sin bootstrap
    const useCase = new GetExternalBulkCampaign(campaignRepo, rbacUserRepo);
    const campaign = await campaignRepo.create({
      name: 'x',
      templateRef: 'HXtest',
      segment: { statuses: [] },
      variableSpec: {},
      total: 1,
      createdById: 'whatever',
    });

    await expect(useCase.execute({ campaignId: campaign.id })).rejects.toThrow(CampaignNotFoundError);
  });
});
