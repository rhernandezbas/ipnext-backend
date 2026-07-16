import { ListRadiusSessionCures } from '@application/use-cases/ListRadiusSessionCures';
import { InMemoryRadiusSessionCureEventRepository } from '@infrastructure/adapters/in-memory/InMemoryRadiusSessionCureEventRepository';

/**
 * radius-session-autocure BE-1 (REQ-CURE-5, S5.1-S5.5) — ListRadiusSessionCures: molde
 * ListRadiusAuthFailures. Paginado + countsByOutcome (ignora el filtro outcome).
 */
describe('ListRadiusSessionCures', () => {
  it('S5.1/S5.3: filtra por outcome pero countsByOutcome trae el desglose completo', async () => {
    const repo = new InMemoryRadiusSessionCureEventRepository();
    await repo.record({ username: 'u1', trigger: 'auto', outcome: 'cured', signalUsed: 'persistent_rejects', actorName: 'sistema' });
    await repo.record({ username: 'u2', trigger: 'auto', outcome: 'cured', signalUsed: 'stale_interim', actorName: 'sistema' });
    await repo.record({ username: 'u3', trigger: 'auto', outcome: 'skipped_alive', actorName: 'sistema' });
    const useCase = new ListRadiusSessionCures(repo);

    const filtered = await useCase.execute({ outcome: 'cured' });
    expect(filtered.data).toHaveLength(2);
    expect(filtered.countsByOutcome.cured).toBe(2);
    expect(filtered.countsByOutcome.skipped_alive).toBe(1);
    expect(filtered.countsByOutcome.failed).toBe(0);
  });

  it('S5.2: fila skipped_alive tiene signalUsed null (visible: soporte ve por qué no se curó)', async () => {
    const repo = new InMemoryRadiusSessionCureEventRepository();
    await repo.record({ username: 'u1', trigger: 'auto', outcome: 'skipped_alive', reason: 'session_fresh_interim', actorName: 'sistema' });
    const useCase = new ListRadiusSessionCures(repo);
    const result = await useCase.execute({});
    expect(result.data[0]?.signalUsed).toBeNull();
    expect(result.data[0]?.outcome).toBe('skipped_alive');
  });

  it('paginado: page/limit default 1/50, cap 200', async () => {
    const repo = new InMemoryRadiusSessionCureEventRepository();
    for (let i = 0; i < 3; i++) await repo.record({ username: `u${i}`, trigger: 'auto', outcome: 'cured', actorName: 'sistema' });
    const useCase = new ListRadiusSessionCures(repo);
    const result = await useCase.execute({ limit: 999 });
    expect(result.limit).toBe(200);
    expect(result.page).toBe(1);
  });

  it('hasNext refleja si hay más páginas', async () => {
    const repo = new InMemoryRadiusSessionCureEventRepository();
    for (let i = 0; i < 3; i++) await repo.record({ username: `u${i}`, trigger: 'auto', outcome: 'cured', actorName: 'sistema' });
    const useCase = new ListRadiusSessionCures(repo);
    const result = await useCase.execute({ limit: 2, page: 1 });
    expect(result.hasNext).toBe(true);
    const result2 = await useCase.execute({ limit: 2, page: 2 });
    expect(result2.hasNext).toBe(false);
  });

  it('mapea el wire contract campo por campo', async () => {
    const repo = new InMemoryRadiusSessionCureEventRepository({ now: () => new Date('2026-07-16T10:00:00Z') });
    await repo.record({
      username: 'u1', nasIp: '10.60.0.10', sessionId: 'sid-1',
      sessionStartedAt: '2026-07-16T09:00:00Z', sessionLastUpdate: '2026-07-16T09:59:00Z',
      signalUsed: 'stale_interim', trigger: 'auto', action: 'both', outcome: 'cured',
      reason: null, actorName: 'sistema',
    });
    const useCase = new ListRadiusSessionCures(repo);
    const result = await useCase.execute({});
    expect(result.data[0]).toMatchObject({
      username: 'u1', nasIp: '10.60.0.10', sessionId: 'sid-1',
      sessionStartedAt: '2026-07-16T09:00:00Z', sessionLastUpdate: '2026-07-16T09:59:00Z',
      signalUsed: 'stale_interim', trigger: 'auto', action: 'both', outcome: 'cured',
      reason: null, actorName: 'sistema', createdAt: '2026-07-16T10:00:00.000Z',
    });
  });
});
