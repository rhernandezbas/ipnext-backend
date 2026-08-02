import { SendPushServiceAlert } from '@application/use-cases/notifications/SendPushServiceAlert';
import { InMemoryPortalPushTokenRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalPushTokenRepository';
import { RegisterPortalPushToken } from '@application/use-cases/portal/RegisterPortalPushToken';
import type { CampaignSegmentSource, CampaignSegmentFilter, CampaignRecipientCandidate } from '@domain/ports/CustomerRepository';
import type { PushSender, PushNotificationPayload, PushSendResult } from '@domain/ports/PushSender';

/** Fake narrow — mismo criterio que `FakeSegmentSource` en promos.routes.test.ts. */
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

class FakePushSender implements PushSender {
  public sentTo: string[][] = [];
  constructor(
    private readonly invalidTokensToReport: string[] = [],
    public readonly dryRun?: boolean,
  ) {}
  async send(tokens: string[], _notification: PushNotificationPayload): Promise<PushSendResult> {
    this.sentTo.push(tokens);
    return { invalidTokens: this.invalidTokensToReport.filter((t) => tokens.includes(t)) };
  }
}

/** Fixture: 2 clientes en el nodo A, 2 en el nodo B; algunos opt-in, algunos no. */
async function buildFixture() {
  const tokens = new InMemoryPortalPushTokenRepository();
  const register = new RegisterPortalPushToken(tokens);

  // 2 con serviceAlerts=true, token vivo, nodo A.
  tokens.seedAccount('account-a1', 'client-a1', true);
  await register.execute('account-a1', { token: 'tok-a1', platform: 'android' });
  tokens.seedAccount('account-a2', 'client-a2', true);
  await register.execute('account-a2', { token: 'tok-a2', platform: 'android' });

  // 2 con serviceAlerts=false (deben quedar EXCLUIDOS aunque tengan token vivo), nodo B.
  tokens.seedAccount('account-b1-off', 'client-b1-off', false);
  await register.execute('account-b1-off', { token: 'tok-b1-off', platform: 'android' });
  tokens.seedAccount('account-b2-off', 'client-b2-off', false);
  await register.execute('account-b2-off', { token: 'tok-b2-off', platform: 'android' });

  // 2 con serviceAlerts=true pero invalidAt seteado (deben quedar EXCLUIDOS), nodo B.
  tokens.seedAccount('account-inv1', 'client-inv1', true);
  await register.execute('account-inv1', { token: 'tok-inv1', platform: 'android' });
  await tokens.markInvalid(['tok-inv1']);
  tokens.seedAccount('account-inv2', 'client-inv2', true);
  await register.execute('account-inv2', { token: 'tok-inv2', platform: 'android' });
  await tokens.markInvalid(['tok-inv2']);

  const segments = new FakeSegmentSource({
    'node-a': [candidate('client-a1'), candidate('client-a2')],
    'node-b': [candidate('client-b1-off'), candidate('client-b2-off'), candidate('client-inv1'), candidate('client-inv2')],
  });

  return { tokens, segments };
}

describe('SendPushServiceAlert', () => {
  it('caso obligatorio 5 — sin nodo: manda a los opt-in con token vivo, EXCLUYE invalidAt no-null y EXCLUYE serviceAlerts=false', async () => {
    const { tokens, segments } = await buildFixture();
    const sender = new FakePushSender();
    const useCase = new SendPushServiceAlert(tokens, sender, segments);

    const result = await useCase.execute({ title: 'Corte programado', body: 'Volvemos a las 15:30' });

    expect(result.recipients).toBe(2); // solo account-a1 y account-a2
    expect(result.devices).toBe(2);
    expect(sender.sentTo[0]?.sort()).toEqual(['tok-a1', 'tok-a2']);
    expect(result.dryRun).toBe(false);
  });

  it('caso obligatorio 6 — con nodo: solo los clientes de ESE nodo', async () => {
    const { tokens, segments } = await buildFixture();
    // Habilito serviceAlerts en node-b para poder distinguir "excluido por nodo" de "excluido por preferencia".
    tokens.seedAccount('account-b1-off', 'client-b1-off', true);
    tokens.seedAccount('account-b2-off', 'client-b2-off', true);
    const sender = new FakePushSender();
    const useCase = new SendPushServiceAlert(tokens, sender, segments);

    const result = await useCase.execute({ title: 'Falla en tu zona', body: 'Estamos trabajando', networkSiteId: 'node-b' });

    // node-b tiene 4 candidatos, pero 2 (inv1/inv2) siguen sin token vivo.
    expect(result.recipients).toBe(2);
    expect(sender.sentTo[0]?.sort()).toEqual(['tok-b1-off', 'tok-b2-off']);
  });

  it('caso obligatorio 7 — tokens inválidos reportados por FCM quedan marcados y no reciben el siguiente envío', async () => {
    const { tokens, segments } = await buildFixture();
    const sender = new FakePushSender(['tok-a1']);
    const useCase = new SendPushServiceAlert(tokens, sender, segments);

    const first = await useCase.execute({ title: 'Aviso 1', body: 'body' });
    expect(first.invalidated).toBe(1);
    expect(tokens.findByToken('tok-a1')?.invalidAt).not.toBeNull();

    const secondSender = new FakePushSender();
    const secondUseCase = new SendPushServiceAlert(tokens, secondSender, segments);
    const second = await secondUseCase.execute({ title: 'Aviso 2', body: 'body' });

    expect(second.recipients).toBe(1); // solo account-a2 sigue vivo
    expect(secondSender.sentTo[0]).toEqual(['tok-a2']);
  });

  it('caso obligatorio 9 (parcial, unit) — sin destinatarios, dryRun=true refleja el sender pero no explota', async () => {
    const tokens = new InMemoryPortalPushTokenRepository();
    const segments = new FakeSegmentSource({});
    const sender = new FakePushSender([], true);
    const useCase = new SendPushServiceAlert(tokens, sender, segments);

    const result = await useCase.execute({ title: 'Aviso', body: 'body' });

    expect(result).toEqual({ recipients: 0, devices: 0, invalidated: 0, dryRun: true });
    expect(sender.sentTo).toHaveLength(0); // sin destinatarios, ni siquiera se llama a send()
  });

  it('nodo sin ningún cliente matcheando -> 0 destinatarios sin tocar el universo completo', async () => {
    const { tokens, segments } = await buildFixture();
    const sender = new FakePushSender();
    const useCase = new SendPushServiceAlert(tokens, sender, segments);

    const result = await useCase.execute({ title: 'Aviso', body: 'body', networkSiteId: 'node-inexistente' });

    expect(result.recipients).toBe(0);
    expect(result.devices).toBe(0);
    expect(sender.sentTo).toHaveLength(0);
  });
});
