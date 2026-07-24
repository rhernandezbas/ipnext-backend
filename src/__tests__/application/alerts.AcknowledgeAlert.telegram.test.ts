import { AcknowledgeAlert } from '@application/use-cases/alerts/AcknowledgeAlert';
import { InMemoryNocAlertRepository } from '@infrastructure/adapters/in-memory/InMemoryNocAlertRepository';
import { NoOpAlertEventPublisher } from '@infrastructure/adapters/in-memory/NoOpAlertEventPublisher';
import { FakeAlertNotifier } from '@infrastructure/adapters/in-memory/FakeAlertNotifier';
import { NocAlert } from '@domain/entities/nocAlert';
import { AlertNotifier } from '@domain/ports/AlertNotifier';

/** F-D5 (fix wave) — notifier cuyo editAck siempre revienta (flake best-effort). */
class ThrowingEditAckNotifier implements AlertNotifier {
  async notify(): Promise<{ chatId: string; messageId: string } | null> {
    return null;
  }
  async editAck(): Promise<void> {
    throw new Error('Telegram editMessage flake');
  }
}

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

  // F-D4 (fix wave, LOW/MEDIUM) — el pre-check `before = findById` + `repo.acknowledge`
  // NO era atómico: dos callbacks CONCURRENTES (doble-tap del mismo botón, o
  // panel+Telegram casi simultáneos) podían AMBOS leer `wasAlreadyAcked === false`
  // antes de que cualquiera de los dos persistiera — el segundo entonces disparaba
  // un editAck y un publish 'acked' de más para un ACK que ya no cambió nada.
  // `Promise.all` sin await intermedio fuerza el interleaving real (ambos
  // `findById` corren ANTES de que el primer `acknowledge` mute el repo).
  it('doble ACK CONCURRENTE (Promise.all, mismo alert) → editAck se dispara UNA sola vez Y se publica UN solo evento acked', async () => {
    const repo = new InMemoryNocAlertRepository();
    seedAlert(repo, { telegramChatId: 'chat-42', telegramMessageId: 'msg-99' });
    const notifier = new FakeAlertNotifier();
    const publisher = new NoOpAlertEventPublisher();
    const useCase = new AcknowledgeAlert(repo, publisher, notifier);

    const [first, second] = await Promise.all([
      useCase.execute('alert-1', 'juan.perez', '2026-07-24T10:15:00.000Z'),
      useCase.execute('alert-1', 'telegram:maria', '2026-07-24T10:15:01.000Z'),
    ]);

    expect(notifier.editAckCalls).toHaveLength(1);
    expect(publisher.published).toHaveLength(1);
    // Cualquiera de los dos pudo ganar la carrera — lo que importa es que
    // AMBOS resultados reflejen el MISMO ack persistido (uno solo "ganó").
    expect(first).toEqual(second);
  });

  // F-D5 (fix wave, LOW) — `editAck` corre DESPUÉS de persistir+publicar; un
  // flake del notifier ahí no debe tirar abajo la request con un 500 sobre un
  // estado que YA se comprometió (el ACK persistió y el evento SSE ya salió).
  it('editAck del notifier revienta (flake) → execute() NO propaga, el ACK ya persistido se devuelve igual', async () => {
    const repo = new InMemoryNocAlertRepository();
    seedAlert(repo, { telegramChatId: 'chat-42', telegramMessageId: 'msg-99' });
    const useCase = new AcknowledgeAlert(repo, new NoOpAlertEventPublisher(), new ThrowingEditAckNotifier());

    const result = await useCase.execute('alert-1', 'juan.perez', '2026-07-24T10:15:00.000Z');

    expect(result?.acknowledged).toBe(true);
    expect(result?.ackBy).toBe('juan.perez');
  });
});
