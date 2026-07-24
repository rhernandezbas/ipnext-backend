import { AcknowledgeAlert } from '@application/use-cases/alerts/AcknowledgeAlert';
import { InMemoryNocAlertRepository } from '@infrastructure/adapters/in-memory/InMemoryNocAlertRepository';
import { NoOpAlertEventPublisher } from '@infrastructure/adapters/in-memory/NoOpAlertEventPublisher';
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

describe('AcknowledgeAlert', () => {
  it('ack de una alerta existente setea ackBy/ackAt', async () => {
    const repo = new InMemoryNocAlertRepository();
    seedAlert(repo);
    const useCase = new AcknowledgeAlert(repo, new NoOpAlertEventPublisher());

    const result = await useCase.execute('alert-1', 'juan.perez', '2026-07-24T10:15:00.000Z');

    expect(result).not.toBeNull();
    expect(result?.acknowledged).toBe(true);
    expect(result?.ackBy).toBe('juan.perez');
    expect(result?.ackAt).toBe('2026-07-24T10:15:00.000Z');
  });

  it('ack de un id inexistente NO lanza — retorna null', async () => {
    const repo = new InMemoryNocAlertRepository();
    const useCase = new AcknowledgeAlert(repo, new NoOpAlertEventPublisher());

    const result = await useCase.execute('does-not-exist', 'juan.perez', '2026-07-24T10:15:00.000Z');

    expect(result).toBeNull();
  });

  it('acepta una nota opcional (ackNote)', async () => {
    const repo = new InMemoryNocAlertRepository();
    seedAlert(repo);
    const useCase = new AcknowledgeAlert(repo, new NoOpAlertEventPublisher());

    const result = await useCase.execute('alert-1', 'juan.perez', '2026-07-24T10:15:00.000Z', 'en investigación');

    expect(result?.ackNote).toBe('en investigación');
  });

  // F4 (fix wave) — MTTA = tiempo al PRIMER ack (decisión de producto/estándar).
  // Un segundo ACK (otro usuario, u otro momento) NO debe pisar ackBy/ackAt/ackNote
  // — antes se pisaba incondicionalmente, lo que inflaba el MTTA cada vez que
  // alguien reconocía de nuevo una alerta ya ackeada.
  it('ACK es idempotente: un segundo ack NO pisa ackBy/ackAt/ackNote del primero', async () => {
    const repo = new InMemoryNocAlertRepository();
    seedAlert(repo);
    const useCase = new AcknowledgeAlert(repo, new NoOpAlertEventPublisher());

    const first = await useCase.execute('alert-1', 'juan.perez', '2026-07-24T10:15:00.000Z', 'primera nota');
    const second = await useCase.execute('alert-1', 'maria.gomez', '2026-07-24T12:00:00.000Z', 'segunda nota');

    expect(second?.ackBy).toBe('juan.perez');
    expect(second?.ackAt).toBe('2026-07-24T10:15:00.000Z');
    expect(second?.ackNote).toBe('primera nota');
    expect(second).toEqual(first);
  });

  // C4 (noc-alert-realtime) — spec.md "Acknowledging an alert publishes an
  // 'acked' event after persist". Spy per Testing Notes ("un AlertEventPublisher
  // fake que registra llamadas, NO el AlertEventBus real — separa 'el use-case
  // publica' de 'el bus entrega'") — NoOpAlertEventPublisher already records
  // every publish() call in `.published` (A4), reused here as the spy.
  it('publica un evento acked por AlertEventPublisher DESPUÉS de persistir el ACK', async () => {
    const repo = new InMemoryNocAlertRepository();
    seedAlert(repo);
    const publisher = new NoOpAlertEventPublisher();
    const useCase = new AcknowledgeAlert(repo, publisher);

    const result = await useCase.execute('alert-1', 'juan.perez', '2026-07-24T10:15:00.000Z');

    expect(publisher.published).toHaveLength(1);
    expect(publisher.published[0]).toEqual({ type: 'acked', alert: result });
  });

  it('ack de un id inexistente NO publica ningún evento (nada persistió)', async () => {
    const repo = new InMemoryNocAlertRepository();
    const publisher = new NoOpAlertEventPublisher();
    const useCase = new AcknowledgeAlert(repo, publisher);

    const result = await useCase.execute('does-not-exist', 'juan.perez', '2026-07-24T10:15:00.000Z');

    expect(result).toBeNull();
    expect(publisher.published).toHaveLength(0);
  });
});
