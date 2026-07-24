import { ListAlerts } from '@application/use-cases/alerts/ListAlerts';
import { InMemoryNocAlertRepository } from '@infrastructure/adapters/in-memory/InMemoryNocAlertRepository';
import { NocAlert } from '@domain/entities/nocAlert';

function seed(repo: InMemoryNocAlertRepository, overrides: Partial<NocAlert>): void {
  const base: NocAlert = {
    id: overrides.id ?? 'x',
    source: 'grafana',
    fingerprint: 'fp',
    alertname: 'alert',
    severity: 'warning',
    status: 'firing',
    entityType: 'router',
    entityName: 'RDA2',
    entityRef: null,
    metricName: null,
    metricValue: null,
    metricUnit: null,
    threshold: null,
    message: 'msg',
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
  repo.seed(base);
}

describe('ListAlerts', () => {
  it('filtro combinado source+severity+status devuelve solo lo que matchea los tres', async () => {
    const repo = new InMemoryNocAlertRepository();
    seed(repo, { id: 'a1', source: 'grafana', severity: 'critical', status: 'firing' });
    seed(repo, { id: 'a2', source: 'grafana', severity: 'warning', status: 'firing' }); // distinta severity
    seed(repo, { id: 'a3', source: 'fiber-collector', severity: 'critical', status: 'firing' }); // distinta source
    seed(repo, { id: 'a4', source: 'grafana', severity: 'critical', status: 'resolved' }); // distinto status
    seed(repo, { id: 'a5', source: 'grafana', severity: 'critical', status: 'firing' }); // matchea también

    const useCase = new ListAlerts(repo);
    const result = await useCase.execute({ source: 'grafana', severity: 'critical', status: 'firing' });

    expect(result.map((a) => a.id).sort()).toEqual(['a1', 'a5']);
  });

  it('sin filtros devuelve todo', async () => {
    const repo = new InMemoryNocAlertRepository();
    seed(repo, { id: 'a1' });
    seed(repo, { id: 'a2', source: 'fiber-collector' });

    const useCase = new ListAlerts(repo);
    const result = await useCase.execute({});

    expect(result).toHaveLength(2);
  });
});
