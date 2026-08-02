import { PreviewPushServiceAlert } from '@application/use-cases/notifications/PreviewPushServiceAlert';
import { InMemoryPortalPushTokenRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalPushTokenRepository';
import { RegisterPortalPushToken } from '@application/use-cases/portal/RegisterPortalPushToken';
import type { CampaignSegmentSource, CampaignSegmentFilter, CampaignRecipientCandidate } from '@domain/ports/CustomerRepository';

class FakeSegmentSource implements Pick<CampaignSegmentSource, 'listSegmentRecipients'> {
  constructor(private readonly byNode: Record<string, CampaignRecipientCandidate[]>) {}
  async listSegmentRecipients(segment: CampaignSegmentFilter): Promise<CampaignRecipientCandidate[]> {
    if (!segment.networkSiteId) return [];
    return this.byNode[segment.networkSiteId] ?? [];
  }
}

function candidate(clientId: string): CampaignRecipientCandidate {
  return { clientId, name: clientId, phone: null, balanceDue: null, whatsappOptOutAt: null };
}

describe('PreviewPushServiceAlert', () => {
  it('cuenta destinatarios reales sin mandar nada', async () => {
    const tokens = new InMemoryPortalPushTokenRepository();
    const register = new RegisterPortalPushToken(tokens);
    tokens.seedAccount('account-1', 'client-1', true);
    await register.execute('account-1', { token: 'tok-1', platform: 'android' });
    tokens.seedAccount('account-2', 'client-2', true);
    await register.execute('account-2', { token: 'tok-2a', platform: 'android' });
    await register.execute('account-2', { token: 'tok-2b', platform: 'ios' });

    const segments = new FakeSegmentSource({});
    const useCase = new PreviewPushServiceAlert(tokens, segments);

    const result = await useCase.execute({});

    expect(result.recipients).toBe(2);
    expect(result.devices).toBe(3); // account-2 tiene 2 dispositivos
  });

  it('MISMOS filtros que SendPushServiceAlert al segmentar por nodo (anti-divergencia)', async () => {
    const tokens = new InMemoryPortalPushTokenRepository();
    const register = new RegisterPortalPushToken(tokens);
    tokens.seedAccount('account-a', 'client-a', true);
    await register.execute('account-a', { token: 'tok-a', platform: 'android' });
    tokens.seedAccount('account-b', 'client-b', true);
    await register.execute('account-b', { token: 'tok-b', platform: 'android' });

    const segments = new FakeSegmentSource({ 'node-a': [candidate('client-a')] });
    const useCase = new PreviewPushServiceAlert(tokens, segments);

    const result = await useCase.execute({ networkSiteId: 'node-a' });

    expect(result.recipients).toBe(1);
    expect(result.devices).toBe(1);
  });
});
