import { AcknowledgeAlert } from '@application/use-cases/alerts/AcknowledgeAlert';
import { InMemoryNocAlertRepository } from '@infrastructure/adapters/in-memory/InMemoryNocAlertRepository';
import { NoOpAlertEventPublisher } from '@infrastructure/adapters/in-memory/NoOpAlertEventPublisher';
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

describe('AcknowledgeAlert — ACK bidireccional Telegram (Fase D, noc-alert-telegram)', () => {
  // D10 — spec.md "Acknowledging from the panel edits the existing Telegram message".
  it('alerta CON telegramChatId/telegramMessageId → invoca AlertNotifier.editAck', async () => {
    const repo = new InMemoryNocAlertRepository();
    seedAlert(repo, { telegramChatId: 'chat-42', telegramMessageId: 'msg-99' });
    const notifier = new FakeAlertNotifier();
    const useCase = new AcknowledgeAlert(repo, new NoOpAlertEventPublisher(), notifier);

    const result = await useCase.execute('alert-1', 'juan.perez', '2026-07-24T10:15:00.000Z');

    expect(notifier.editAckCalls).toHaveLength(1);
    expect(notifier.editAckCalls[0]?.id).toBe('alert-1');
    expect(notifier.editAckCalls[0]?.ackBy).toBe('juan.perez');
    expect(result?.ackBy).toBe('juan.perez');
  });

  // D11 — spec.md "Acknowledging an alert without Telegram metadata does not attempt to edit".
  it('alerta SIN metadata de Telegram (flag OFF al ingestar) → editAck NO se invoca, el ACK persiste igual', async () => {
    const repo = new InMemoryNocAlertRepository();
    seedAlert(repo); // telegramChatId/telegramMessageId: null (default)
    const notifier = new FakeAlertNotifier();
    const useCase = new AcknowledgeAlert(repo, new NoOpAlertEventPublisher(), notifier);

    const result = await useCase.execute('alert-1', 'juan.perez', '2026-07-24T10:15:00.000Z');

    expect(notifier.editAckCalls).toHaveLength(0);
    expect(result?.acknowledged).toBe(true);
  });

  it('sin notifier inyectado (backward-compat, pre-Fase-D) → no revienta, no intenta editAck', async () => {
    const repo = new InMemoryNocAlertRepository();
    seedAlert(repo, { telegramChatId: 'chat-42', telegramMessageId: 'msg-99' });
    const useCase = new AcknowledgeAlert(repo, new NoOpAlertEventPublisher());

    const result = await useCase.execute('alert-1', 'juan.perez', '2026-07-24T10:15:00.000Z');

    expect(result?.acknowledged).toBe(true);
  });

  // D12 — spec.md "Double acknowledge is idempotent across channels": un segundo
  // intento (canal contrario) no pisa ackBy/ackAt original NI dispara un segundo editAck.
  it('doble ACK (ya ackeado) desde el canal contrario → idempotente, editAck se dispara UNA sola vez', async () => {
    const repo = new InMemoryNocAlertRepository();
    seedAlert(repo, { telegramChatId: 'chat-42', telegramMessageId: 'msg-99' });
    const notifier = new FakeAlertNotifier();
    const useCase = new AcknowledgeAlert(repo, new NoOpAlertEventPublisher(), notifier);

    const first = await useCase.execute('alert-1', 'juan.perez', '2026-07-24T10:15:00.000Z');
    const second = await useCase.execute('alert-1', 'telegram:maria', '2026-07-24T12:00:00.000Z');

    expect(notifier.editAckCalls).toHaveLength(1);
    expect(second?.ackBy).toBe('juan.perez');
    expect(second?.ackAt).toBe('2026-07-24T10:15:00.000Z');
    expect(second).toEqual(first);
  });
});
