import { AcknowledgeAlert } from '@application/use-cases/alerts/AcknowledgeAlert';
import { InMemoryNocAlertRepository } from '@infrastructure/adapters/in-memory/InMemoryNocAlertRepository';
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
    const useCase = new AcknowledgeAlert(repo);

    const result = await useCase.execute('alert-1', 'juan.perez', '2026-07-24T10:15:00.000Z');

    expect(result).not.toBeNull();
    expect(result?.acknowledged).toBe(true);
    expect(result?.ackBy).toBe('juan.perez');
    expect(result?.ackAt).toBe('2026-07-24T10:15:00.000Z');
  });

  it('ack de un id inexistente NO lanza — retorna null', async () => {
    const repo = new InMemoryNocAlertRepository();
    const useCase = new AcknowledgeAlert(repo);

    const result = await useCase.execute('does-not-exist', 'juan.perez', '2026-07-24T10:15:00.000Z');

    expect(result).toBeNull();
  });

  it('acepta una nota opcional (ackNote)', async () => {
    const repo = new InMemoryNocAlertRepository();
    seedAlert(repo);
    const useCase = new AcknowledgeAlert(repo);

    const result = await useCase.execute('alert-1', 'juan.perez', '2026-07-24T10:15:00.000Z', 'en investigación');

    expect(result?.ackNote).toBe('en investigación');
  });
});
