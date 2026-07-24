/**
 * alerts.AcknowledgeAlert.audit.test.ts — F2 (noc-alerts-config, lado BE) —
 * auditoría ESTRUCTURADA del ACK (`entityType='NocAlert'`, `entityId`,
 * `action='alert.acknowledge'`, canal + actor real en el metadata).
 *
 * Hoy `auditMutationsMiddleware` (global) sólo loguea una fila GENÉRICA
 * (action=null, entityType=null) para toda mutación bajo /api/alerts — no
 * filtrable ni atribuible. `AcknowledgeAlert` ahora recibe un
 * `AuditEventRepository` (4to param constructor, opcional — backward-compat
 * con los 6 call-sites de 2/3-arg existentes) y escribe la fila rica DIRECTO,
 * sin depender de Express (req/res) — mantiene el use-case framework-agnostic
 * (hexagonal estricto).
 */
import { AcknowledgeAlert } from '@application/use-cases/alerts/AcknowledgeAlert';
import { InMemoryNocAlertRepository } from '@infrastructure/adapters/in-memory/InMemoryNocAlertRepository';
import { NoOpAlertEventPublisher } from '@infrastructure/adapters/in-memory/NoOpAlertEventPublisher';
import { InMemoryAuditEventRepository } from '@infrastructure/adapters/in-memory/InMemoryAuditEventRepository';
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

describe('AcknowledgeAlert — auditoría estructurada (F2, noc-alerts-config)', () => {
  it('ACK desde el panel escribe UN AuditEvent con action/entityType/entityId + canal=panel + actor real', async () => {
    const repo = new InMemoryNocAlertRepository();
    seedAlert(repo);
    const auditRepo = new InMemoryAuditEventRepository();
    const useCase = new AcknowledgeAlert(repo, new NoOpAlertEventPublisher(), undefined, auditRepo);

    await useCase.execute('alert-1', 'juan.perez', '2026-07-24T10:15:00.000Z', 'en investigación', 'panel');

    const page = await auditRepo.list({});
    expect(page.items).toHaveLength(1);
    const ev = page.items[0];
    expect(ev?.action).toBe('alert.acknowledge');
    expect(ev?.entityType).toBe('NocAlert');
    expect(ev?.entityId).toBe('alert-1');
    expect(ev?.actorLogin).toBe('juan.perez');
    expect(ev?.afterJson).toMatchObject({ channel: 'panel', actor: 'juan.perez' });
  });

  it('ACK desde telegram escribe canal=telegram + actor=telegram:<user> (NO anonymous)', async () => {
    const repo = new InMemoryNocAlertRepository();
    seedAlert(repo);
    const auditRepo = new InMemoryAuditEventRepository();
    const useCase = new AcknowledgeAlert(repo, new NoOpAlertEventPublisher(), undefined, auditRepo);

    await useCase.execute('alert-1', 'telegram:maria', '2026-07-24T10:15:00.000Z', undefined, 'telegram');

    const page = await auditRepo.list({});
    expect(page.items).toHaveLength(1);
    const ev = page.items[0];
    expect(ev?.actorLogin).toBe('telegram:maria');
    expect(ev?.actorLogin).not.toBe('anonymous');
    expect(ev?.afterJson).toMatchObject({ channel: 'telegram', actor: 'telegram:maria' });
  });

  it('sin auditRepo inyectado (backward-compat) → no revienta, el ACK persiste igual', async () => {
    const repo = new InMemoryNocAlertRepository();
    seedAlert(repo);
    const useCase = new AcknowledgeAlert(repo, new NoOpAlertEventPublisher());

    const result = await useCase.execute('alert-1', 'juan.perez', '2026-07-24T10:15:00.000Z');

    expect(result?.acknowledged).toBe(true);
  });

  it('ack de un id inexistente → NO escribe ningún AuditEvent (nada cambió)', async () => {
    const repo = new InMemoryNocAlertRepository();
    const auditRepo = new InMemoryAuditEventRepository();
    const useCase = new AcknowledgeAlert(repo, new NoOpAlertEventPublisher(), undefined, auditRepo);

    const result = await useCase.execute('does-not-exist', 'juan.perez', '2026-07-24T10:15:00.000Z');

    expect(result).toBeNull();
    const page = await auditRepo.list({});
    expect(page.items).toHaveLength(0);
  });

  it('doble ACK (idempotente, changed=false) → NO escribe una segunda fila de auditoría', async () => {
    const repo = new InMemoryNocAlertRepository();
    seedAlert(repo);
    const auditRepo = new InMemoryAuditEventRepository();
    const useCase = new AcknowledgeAlert(repo, new NoOpAlertEventPublisher(), undefined, auditRepo);

    await useCase.execute('alert-1', 'juan.perez', '2026-07-24T10:15:00.000Z', undefined, 'panel');
    await useCase.execute('alert-1', 'telegram:maria', '2026-07-24T12:00:00.000Z', undefined, 'telegram');

    const page = await auditRepo.list({});
    expect(page.items).toHaveLength(1);
  });

  it('un fallo del auditRepo.record NO propaga — el ACK ya persistido se devuelve igual', async () => {
    const repo = new InMemoryNocAlertRepository();
    seedAlert(repo);
    const throwingAuditRepo = {
      record: jest.fn().mockRejectedValue(new Error('DB down')),
      list: jest.fn(),
    };
    const useCase = new AcknowledgeAlert(repo, new NoOpAlertEventPublisher(), undefined, throwingAuditRepo);

    const result = await useCase.execute('alert-1', 'juan.perez', '2026-07-24T10:15:00.000Z');

    expect(result?.acknowledged).toBe(true);
  });

  it('el default de canal (sin pasar el 5to arg) es "panel"', async () => {
    const repo = new InMemoryNocAlertRepository();
    seedAlert(repo);
    const auditRepo = new InMemoryAuditEventRepository();
    const useCase = new AcknowledgeAlert(repo, new NoOpAlertEventPublisher(), undefined, auditRepo);

    await useCase.execute('alert-1', 'juan.perez', '2026-07-24T10:15:00.000Z');

    const page = await auditRepo.list({});
    expect(page.items[0]?.afterJson).toMatchObject({ channel: 'panel' });
  });
});
