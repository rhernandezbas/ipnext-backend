import { NotifyAlert, TELEGRAM_SEND_FLAG } from '@application/use-cases/alerts/NotifyAlert';
import { InMemoryNocAlertRepository } from '@infrastructure/adapters/in-memory/InMemoryNocAlertRepository';
import { InMemoryFeatureFlagRepository } from '@infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { FakeAlertNotifier } from '@infrastructure/adapters/in-memory/FakeAlertNotifier';
import { NocAlert } from '@domain/entities/nocAlert';

function seedAlert(repo: InMemoryNocAlertRepository, overrides: Partial<NocAlert> = {}): NocAlert {
  const alert: NocAlert = {
    id: 'alert-1',
    source: 'grafana',
    fingerprint: 'fp-1',
    alertname: 'BGP peer down',
    severity: 'critical',
    status: 'firing',
    entityType: 'bgp_peer',
    entityName: 'peer-rda2',
    entityRef: null,
    metricName: null,
    metricValue: null,
    metricUnit: null,
    threshold: null,
    message: 'BGP peer down',
    explanation: null,
    link: null,
    startsAt: '2026-07-24T10:00:00.000Z',
    firstSeen: '2026-07-24T10:00:00.000Z',
    lastSeen: '2026-07-24T10:00:00.000Z',
    endsAt: null,
    createdAt: '2026-07-24T10:00:00.000Z',
    updatedAt: '2026-07-24T10:00:00.000Z',
    acknowledged: false,
    ackBy: null,
    ackAt: null,
    ackNote: null,
    escalationState: null,
    telegramChatId: null,
    telegramMessageId: null,
    ...overrides,
  };
  repo.seed(alert);
  return alert;
}

describe('NotifyAlert (Fase D, noc-alert-telegram)', () => {
  // D3 — spec.md "Flag OFF sends nothing (convivencia)".
  it('flag OFF (default de convivencia) → AlertNotifier.notify NO se invoca', async () => {
    const repo = new InMemoryNocAlertRepository();
    const alert = seedAlert(repo);
    const notifier = new FakeAlertNotifier();
    const featureFlagRepo = new InMemoryFeatureFlagRepository();
    featureFlagRepo.seed(TELEGRAM_SEND_FLAG, false);
    const useCase = new NotifyAlert(repo, notifier, featureFlagRepo);

    await useCase.execute(alert);

    expect(notifier.notifyCalls).toHaveLength(0);
  });

  // Flag NUNCA seedeado (fila ausente) — mismo default OFF que un OFF explícito.
  it('flag ausente (nunca seedeado) → tratado como OFF, NO invoca notify', async () => {
    const repo = new InMemoryNocAlertRepository();
    const alert = seedAlert(repo);
    const notifier = new FakeAlertNotifier();
    const featureFlagRepo = new InMemoryFeatureFlagRepository();
    const useCase = new NotifyAlert(repo, notifier, featureFlagRepo);

    await useCase.execute(alert);

    expect(notifier.notifyCalls).toHaveLength(0);
  });

  // D4 — spec.md "Flag ON sends a Telegram message with an inline button".
  it('flag ON → AlertNotifier.notify se invoca UNA vez; chatId/messageId devueltos quedan guardados en el NocAlert', async () => {
    const repo = new InMemoryNocAlertRepository();
    const alert = seedAlert(repo);
    const notifier = new FakeAlertNotifier();
    notifier.notifyResult = { chatId: 'chat-42', messageId: 'msg-99' };
    const featureFlagRepo = new InMemoryFeatureFlagRepository();
    featureFlagRepo.seed(TELEGRAM_SEND_FLAG, true);
    const useCase = new NotifyAlert(repo, notifier, featureFlagRepo);

    await useCase.execute(alert);

    expect(notifier.notifyCalls).toHaveLength(1);
    expect(notifier.notifyCalls[0]?.id).toBe('alert-1');

    const stored = await repo.findById('alert-1');
    expect(stored?.telegramChatId).toBe('chat-42');
    expect(stored?.telegramMessageId).toBe('msg-99');
  });

  it('flag ON pero notify() falla/devuelve null (best-effort) → NO intenta guardar metadata, no revienta', async () => {
    const repo = new InMemoryNocAlertRepository();
    const alert = seedAlert(repo);
    const notifier = new FakeAlertNotifier();
    notifier.notifyResult = null;
    const featureFlagRepo = new InMemoryFeatureFlagRepository();
    featureFlagRepo.seed(TELEGRAM_SEND_FLAG, true);
    const useCase = new NotifyAlert(repo, notifier, featureFlagRepo);

    await expect(useCase.execute(alert)).resolves.toBeUndefined();

    const stored = await repo.findById('alert-1');
    expect(stored?.telegramChatId).toBeNull();
    expect(stored?.telegramMessageId).toBeNull();
  });

  // F-D1 (fix wave, HIGH) — spam de Telegram al cutover: Grafana re-evalúa y el
  // sensor de fibra re-postea 'firing' cada ~30min para el MISMO incidente
  // (mismo source+fingerprint, upsert in place — ver computeNocAlertIngest).
  // Sin este guard, cada re-fire mandaba un mensaje NUEVO y pisaba el
  // telegramMessageId guardado, en vez de dejar el mensaje original quieto.
  it('alerta firing que YA tiene telegramChatId/telegramMessageId (ya notificada) → notify() NO se invoca de nuevo', async () => {
    const repo = new InMemoryNocAlertRepository();
    const alert = seedAlert(repo, { telegramChatId: 'chat-42', telegramMessageId: 'msg-99' });
    const notifier = new FakeAlertNotifier();
    const featureFlagRepo = new InMemoryFeatureFlagRepository();
    featureFlagRepo.seed(TELEGRAM_SEND_FLAG, true);
    const useCase = new NotifyAlert(repo, notifier, featureFlagRepo);

    await useCase.execute(alert);

    expect(notifier.notifyCalls).toHaveLength(0);
  });
});
