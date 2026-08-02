import { SendPushServiceAlert } from '@application/use-cases/notifications/SendPushServiceAlert';
import { InMemoryPortalPushTokenRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalPushTokenRepository';
import { InMemoryPortalNotificationRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalNotificationRepository';
import { RegisterPortalPushToken } from '@application/use-cases/portal/RegisterPortalPushToken';
import type { CampaignSegmentSource, CampaignSegmentFilter, CampaignRecipientCandidate } from '@domain/ports/CustomerRepository';
import type { PushSender, PushNotificationPayload, PushSendResult } from '@domain/ports/PushSender';
import type { PortalNotificationRepository, CreatePortalNotificationInput } from '@domain/ports/PortalNotificationRepository';
import type { PortalNotification } from '@domain/entities/portalNotification';
import type { PortalAccountRepository, PortalAccountClientRef } from '@domain/ports/PortalAccountRepository';

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

/**
 * FakeAccountDirectory — universo del BUZÓN (`PortalAccountRepository.listByClientIds`),
 * deliberadamente SIN preferencias de push (ver el docblock de `SendPushServiceAlert`,
 * timbre vs registro) — un fake narrow que devuelve el par (accountId, clientId) que
 * el caller le seedee, sin ningún concepto de `serviceAlerts`.
 */
class FakeAccountDirectory implements Pick<PortalAccountRepository, 'listByClientIds'> {
  constructor(private readonly rows: PortalAccountClientRef[]) {}
  async listByClientIds(clientIds?: string[]): Promise<PortalAccountClientRef[]> {
    if (clientIds && clientIds.length === 0) return [];
    const set = clientIds ? new Set(clientIds) : null;
    return this.rows.filter((r) => !set || set.has(r.clientId));
  }
}

/** Fake que SIEMPRE tira — portal-notification-inbox caso 6 (el insert del buzón nunca tumba el envío). */
class FailingNotificationRepository implements Pick<PortalNotificationRepository, 'create'> {
  public attempts = 0;
  async create(_input: CreatePortalNotificationInput): Promise<PortalNotification> {
    this.attempts++;
    throw new Error('boom — DB caída');
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

  // 2 con serviceAlerts=false — EXCLUIDOS del PUSH, pero SÍ reciben fila de
  // buzón (timbre vs registro, ver el docblock de SendPushServiceAlert), nodo B.
  tokens.seedAccount('account-b1-off', 'client-b1-off', false);
  await register.execute('account-b1-off', { token: 'tok-b1-off', platform: 'android' });
  tokens.seedAccount('account-b2-off', 'client-b2-off', false);
  await register.execute('account-b2-off', { token: 'tok-b2-off', platform: 'android' });

  // 2 con serviceAlerts=true pero invalidAt seteado (deben quedar EXCLUIDOS del PUSH), nodo B.
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

  // Universo del buzón — LAS 6 cuentas, sin filtro de serviceAlerts.
  const accounts = new FakeAccountDirectory([
    { accountId: 'account-a1', clientId: 'client-a1' },
    { accountId: 'account-a2', clientId: 'client-a2' },
    { accountId: 'account-b1-off', clientId: 'client-b1-off' },
    { accountId: 'account-b2-off', clientId: 'client-b2-off' },
    { accountId: 'account-inv1', clientId: 'client-inv1' },
    { accountId: 'account-inv2', clientId: 'client-inv2' },
  ]);

  return { tokens, segments, accounts };
}

describe('SendPushServiceAlert', () => {
  it('caso obligatorio 5 — sin nodo: manda a los opt-in con token vivo, EXCLUYE invalidAt no-null y EXCLUYE serviceAlerts=false', async () => {
    const { tokens, segments, accounts } = await buildFixture();
    const sender = new FakePushSender();
    const notifications = new InMemoryPortalNotificationRepository();
    const useCase = new SendPushServiceAlert(tokens, sender, segments, notifications, accounts);

    const result = await useCase.execute({ title: 'Corte programado', body: 'Volvemos a las 15:30' });

    expect(result.recipients).toBe(2); // solo account-a1 y account-a2
    expect(result.devices).toBe(2);
    expect(sender.sentTo[0]?.sort()).toEqual(['tok-a1', 'tok-a2']);
    expect(result.dryRun).toBe(false);
    // Buzón: universo completo (6), SIN mirar serviceAlerts — ver test dedicado más abajo.
    expect(result.inboxed).toBe(6);
  });

  it('caso obligatorio 5 (motivador del change, push-per-device) — dos teléfonos de la MISMA cuenta, uno con serviceAlerts=false: el envío le llega a UNO solo', async () => {
    const tokens = new InMemoryPortalPushTokenRepository();
    const register = new RegisterPortalPushToken(tokens);
    tokens.seedAccount('account-family', 'client-family', true);
    await register.execute('account-family', { token: 'phone-mom', platform: 'android' });
    await register.execute('account-family', { token: 'phone-dad', platform: 'android' });
    // El padre apaga los avisos de servicio en SU teléfono — la madre sigue recibiéndolos.
    await tokens.updatePreferences('account-family', 'phone-dad', { serviceAlerts: false });

    const segments = new FakeSegmentSource({});
    const sender = new FakePushSender();
    const notifications = new InMemoryPortalNotificationRepository();
    const accounts = new FakeAccountDirectory([{ accountId: 'account-family', clientId: 'client-family' }]);
    const useCase = new SendPushServiceAlert(tokens, sender, segments, notifications, accounts);

    const result = await useCase.execute({ title: 'Corte programado', body: 'Volvemos a las 15:30' });

    expect(result.recipients).toBe(1); // UNA cuenta, con >=1 token calificado
    expect(result.devices).toBe(1); // UN SOLO teléfono recibió el push
    expect(sender.sentTo[0]).toEqual(['phone-mom']);
  });

  it('caso obligatorio 6 — con nodo: solo los clientes de ESE nodo', async () => {
    const { tokens, segments, accounts } = await buildFixture();
    // Habilito serviceAlerts en node-b para poder distinguir "excluido por nodo" de "excluido por preferencia".
    tokens.seedAccount('account-b1-off', 'client-b1-off', true);
    tokens.seedAccount('account-b2-off', 'client-b2-off', true);
    const sender = new FakePushSender();
    const notifications = new InMemoryPortalNotificationRepository();
    const useCase = new SendPushServiceAlert(tokens, sender, segments, notifications, accounts);

    const result = await useCase.execute({ title: 'Falla en tu zona', body: 'Estamos trabajando', networkSiteId: 'node-b' });

    // node-b tiene 4 candidatos, pero 2 (inv1/inv2) siguen sin token vivo.
    expect(result.recipients).toBe(2);
    expect(sender.sentTo[0]?.sort()).toEqual(['tok-b1-off', 'tok-b2-off']);
    // Buzón: las 4 cuentas del nodo (el filtro de nodo SÍ aplica al buzón).
    expect(result.inboxed).toBe(4);
  });

  it('caso obligatorio 7 — tokens inválidos reportados por FCM quedan marcados y no reciben el siguiente envío', async () => {
    const { tokens, segments, accounts } = await buildFixture();
    const sender = new FakePushSender(['tok-a1']);
    const notifications = new InMemoryPortalNotificationRepository();
    const useCase = new SendPushServiceAlert(tokens, sender, segments, notifications, accounts);

    const first = await useCase.execute({ title: 'Aviso 1', body: 'body' });
    expect(first.invalidated).toBe(1);
    expect(tokens.findByToken('tok-a1')?.invalidAt).not.toBeNull();

    const secondSender = new FakePushSender();
    const secondUseCase = new SendPushServiceAlert(tokens, secondSender, segments, notifications, accounts);
    const second = await secondUseCase.execute({ title: 'Aviso 2', body: 'body' });

    expect(second.recipients).toBe(1); // solo account-a2 sigue vivo
    expect(secondSender.sentTo[0]).toEqual(['tok-a2']);
  });

  it('caso obligatorio 9 (parcial, unit) — sin destinatarios, dryRun=true refleja el sender pero no explota', async () => {
    const tokens = new InMemoryPortalPushTokenRepository();
    const segments = new FakeSegmentSource({});
    const sender = new FakePushSender([], true);
    const notifications = new InMemoryPortalNotificationRepository();
    const accounts = new FakeAccountDirectory([]);
    const useCase = new SendPushServiceAlert(tokens, sender, segments, notifications, accounts);

    const result = await useCase.execute({ title: 'Aviso', body: 'body' });

    expect(result).toEqual({ recipients: 0, devices: 0, invalidated: 0, dryRun: true, inboxed: 0 });
    expect(sender.sentTo).toHaveLength(0); // sin destinatarios, ni siquiera se llama a send()
  });

  it('nodo sin ningún cliente matcheando -> 0 destinatarios sin tocar el universo completo', async () => {
    const { tokens, segments, accounts } = await buildFixture();
    const sender = new FakePushSender();
    const notifications = new InMemoryPortalNotificationRepository();
    const useCase = new SendPushServiceAlert(tokens, sender, segments, notifications, accounts);

    const result = await useCase.execute({ title: 'Aviso', body: 'body', networkSiteId: 'node-inexistente' });

    expect(result.recipients).toBe(0);
    expect(result.devices).toBe(0);
    expect(sender.sentTo).toHaveLength(0);
    expect(result.inboxed).toBe(0);
  });

  describe('portal-notification-inbox — timbre vs registro', () => {
    it('caso obligatorio 1 — una cuenta con serviceAlerts=false SÍ recibe fila de buzón (aunque NO reciba push)', async () => {
      const { tokens, segments, accounts } = await buildFixture();
      const sender = new FakePushSender();
      const notifications = new InMemoryPortalNotificationRepository();
      const useCase = new SendPushServiceAlert(tokens, sender, segments, notifications, accounts);

      await useCase.execute({ title: 'Corte programado', body: 'Volvemos a las 15:30' });

      // account-b1-off/b2-off tienen serviceAlerts=false: no están entre los
      // tokens a los que se mandó el push (sender.sentTo[0] = ['tok-a1','tok-a2']
      // solamente)...
      const pushedTokens = new Set(sender.sentTo.flat());
      expect(pushedTokens.has('tok-b1-off')).toBe(false);
      expect(pushedTokens.has('tok-b2-off')).toBe(false);

      // ...pero SÍ tienen una fila en el buzón.
      const all = await notifications.listForAccount('account-b1-off', {});
      expect(all.data).toHaveLength(1);
      expect(all.data[0]?.channel).toBe('service');
      expect(all.data[0]?.readAt).toBeNull();
      const other = await notifications.listForAccount('account-b2-off', {});
      expect(other.data).toHaveLength(1);
    });

    it('caso obligatorio 2 — el filtro de nodo también aplica al buzón: cuenta de OTRO nodo no recibe fila', async () => {
      const { tokens, segments, accounts } = await buildFixture();
      const sender = new FakePushSender();
      const notifications = new InMemoryPortalNotificationRepository();
      const useCase = new SendPushServiceAlert(tokens, sender, segments, notifications, accounts);

      // node-a solo tiene client-a1/client-a2 — las cuentas de node-b (incluida
      // account-b1-off, serviceAlerts=false) quedan FUERA del buzón acá.
      await useCase.execute({ title: 'Falla en tu zona', body: 'Trabajando', networkSiteId: 'node-a' });

      const inNode = await notifications.listForAccount('account-a1', {});
      expect(inNode.data).toHaveLength(1);
      const outsideNode = await notifications.listForAccount('account-b1-off', {});
      expect(outsideNode.data).toHaveLength(0);
    });

    it('caso obligatorio 6 (unit) — el insert del buzón que tira NO tumba el envío del push', async () => {
      const { tokens, segments, accounts } = await buildFixture();
      const sender = new FakePushSender();
      const failingNotifications = new FailingNotificationRepository();
      const useCase = new SendPushServiceAlert(tokens, sender, segments, failingNotifications, accounts);

      const result = await useCase.execute({ title: 'Corte programado', body: 'Volvemos a las 15:30' });

      // El push salió igual (misma cuenta 2/2 de siempre).
      expect(result.recipients).toBe(2);
      expect(sender.sentTo[0]?.sort()).toEqual(['tok-a1', 'tok-a2']);
      // El buzón lo refleja: se intentó con las 6 cuentas, ninguna se persistió.
      expect(failingNotifications.attempts).toBe(6);
      expect(result.inboxed).toBe(0);
    });
  });
});
