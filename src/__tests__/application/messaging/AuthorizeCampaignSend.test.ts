/**
 * bulk-granular-perms — AuthorizeCampaignSend. Re-chequeo de permisos granulares
 * en el ENVÍO: reconstruye destinatarios sintéticos desde el snapshot persistido
 * (recipientStatuses + hasRawRecipients) y BLOQUEA si el sender no tiene permiso.
 */
import { AuthorizeCampaignSend } from '@application/use-cases/messaging/AuthorizeCampaignSend';
import { InMemoryCampaignRepository } from '@infrastructure/adapters/in-memory/InMemoryCampaignRepository';
import { BulkRecipientsNotPermittedError, CampaignNotFoundError } from '@domain/errors/messaging-bulk';

async function seed(
  repo: InMemoryCampaignRepository,
  recipientStatuses: string[],
  hasRawRecipients: boolean,
) {
  return repo.create({
    name: 'c', templateRef: 'HXabc', segment: { statuses: recipientStatuses },
    variableSpec: {}, total: 1, createdById: 'admin', recipientStatuses, hasRawRecipients,
  });
}

describe('AuthorizeCampaignSend', () => {
  it('sender con permiso de todos los estados presentes → no throw', async () => {
    const repo = new InMemoryCampaignRepository();
    const uc = new AuthorizeCampaignSend(repo);
    const campaign = await seed(repo, ['late', 'blocked'], false);

    await expect(
      uc.execute({ campaignId: campaign.id, allowedBulkActions: new Set(['bulk_late', 'bulk_blocked']) }),
    ).resolves.toBeUndefined();
  });

  it('sender SIN el permiso de un estado del snapshot → BulkRecipientsNotPermittedError con forbidden', async () => {
    const repo = new InMemoryCampaignRepository();
    const uc = new AuthorizeCampaignSend(repo);
    const campaign = await seed(repo, ['late', 'blocked'], false);

    let caught: unknown;
    try {
      await uc.execute({ campaignId: campaign.id, allowedBulkActions: new Set(['bulk_late']) });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BulkRecipientsNotPermittedError);
    expect((caught as BulkRecipientsNotPermittedError).forbidden).toEqual(['blocked']);
  });

  it('snapshot con números crudos (hasRawRecipients) sin bulk_numbers → forbidden ["números"]', async () => {
    const repo = new InMemoryCampaignRepository();
    const uc = new AuthorizeCampaignSend(repo);
    const campaign = await seed(repo, [], true);

    await expect(
      uc.execute({ campaignId: campaign.id, allowedBulkActions: new Set(['bulk_active']) }),
    ).rejects.toBeInstanceOf(BulkRecipientsNotPermittedError);
  });

  it('super_admin (["*"]) → no throw sea cual sea el snapshot', async () => {
    const repo = new InMemoryCampaignRepository();
    const uc = new AuthorizeCampaignSend(repo);
    const campaign = await seed(repo, ['blocked', 'baja'], true);

    await expect(
      uc.execute({ campaignId: campaign.id, allowedBulkActions: new Set(['*']) }),
    ).resolves.toBeUndefined();
  });

  it('allowedBulkActions undefined → no enforcement (backcompat), no throw', async () => {
    const repo = new InMemoryCampaignRepository();
    const uc = new AuthorizeCampaignSend(repo);
    const campaign = await seed(repo, ['blocked'], true);

    await expect(uc.execute({ campaignId: campaign.id })).resolves.toBeUndefined();
  });

  it('campaña inexistente → CampaignNotFoundError', async () => {
    const repo = new InMemoryCampaignRepository();
    const uc = new AuthorizeCampaignSend(repo);

    await expect(
      uc.execute({ campaignId: 'no-existe', allowedBulkActions: new Set(['bulk_active']) }),
    ).rejects.toBeInstanceOf(CampaignNotFoundError);
  });

  // ── F1 (BYPASS) — snapshot vacío de una campaña pre-migración → fail-closed ────
  describe('F1: snapshot indeterminado (campaña pre-migración) → fail-closed', () => {
    it('recipientStatuses:[] + hasRawRecipients:false + total>0 + sender NO-super-admin → BulkRecipientsNotPermittedError con ["desconocido"]', async () => {
      const repo = new InMemoryCampaignRepository();
      const uc = new AuthorizeCampaignSend(repo);
      // campaña "pre-migración": el DEFAULT del snapshot, PERO con destinatarios reales.
      const campaign = await repo.create({
        name: 'vieja', templateRef: 'HXabc', segment: { statuses: ['late'] },
        variableSpec: {}, total: 5, createdById: 'admin',
        recipientStatuses: [], hasRawRecipients: false,
      });

      let caught: unknown;
      try {
        await uc.execute({ campaignId: campaign.id, allowedBulkActions: new Set(['bulk_late', 'bulk_numbers']) });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BulkRecipientsNotPermittedError);
      expect((caught as BulkRecipientsNotPermittedError).forbidden).toEqual(['desconocido']);
    });

    it('MISMO caso pero super_admin (["*"]) → pasa (super_admin envía cualquier campaña, incluso viejas)', async () => {
      const repo = new InMemoryCampaignRepository();
      const uc = new AuthorizeCampaignSend(repo);
      const campaign = await repo.create({
        name: 'vieja', templateRef: 'HXabc', segment: { statuses: ['late'] },
        variableSpec: {}, total: 5, createdById: 'admin',
        recipientStatuses: [], hasRawRecipients: false,
      });

      await expect(
        uc.execute({ campaignId: campaign.id, allowedBulkActions: new Set(['*']) }),
      ).resolves.toBeUndefined();
    });

    it('total 0 (campaña genuinamente vacía, snapshot vacío) → NO bloquea (no hay destinatarios que autorizar)', async () => {
      const repo = new InMemoryCampaignRepository();
      const uc = new AuthorizeCampaignSend(repo);
      const campaign = await repo.create({
        name: 'vacía', templateRef: 'HXabc', segment: { statuses: [] },
        variableSpec: {}, total: 0, createdById: 'admin',
        recipientStatuses: [], hasRawRecipients: false,
      });

      await expect(
        uc.execute({ campaignId: campaign.id, allowedBulkActions: new Set(['bulk_active']) }),
      ).resolves.toBeUndefined();
    });

    it('snapshot POBLADO sigue funcionando (regresión): estados presentes se chequean normal', async () => {
      const repo = new InMemoryCampaignRepository();
      const uc = new AuthorizeCampaignSend(repo);
      const campaign = await seed(repo, ['late'], false); // total 1, snapshot poblado

      await expect(
        uc.execute({ campaignId: campaign.id, allowedBulkActions: new Set(['bulk_late']) }),
      ).resolves.toBeUndefined();
    });
  });
});
