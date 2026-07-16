import { InMemoryRadiusSessionCureEventRepository } from '@infrastructure/adapters/in-memory/InMemoryRadiusSessionCureEventRepository';

/**
 * radius-session-autocure BE-1 (REQ-CURE-5) — test seam del registro de curas.
 * Molde InMemoryPppoeNasMoveEventRepository / InMemoryRadiusAuthEventRepository.
 */
describe('InMemoryRadiusSessionCureEventRepository', () => {
  it('record() persiste con defaults null y createdAt ISO', async () => {
    const repo = new InMemoryRadiusSessionCureEventRepository({ now: () => new Date('2026-07-16T10:00:00Z') });
    const ev = await repo.record({ username: 'cliente001', trigger: 'auto', outcome: 'cured' });
    expect(ev.id).toBeTruthy();
    expect(ev.username).toBe('cliente001');
    expect(ev.nasIp).toBeNull();
    expect(ev.sessionId).toBeNull();
    expect(ev.signalUsed).toBeNull();
    expect(ev.action).toBeNull();
    expect(ev.trigger).toBe('auto');
    expect(ev.outcome).toBe('cured');
    expect(ev.createdAt).toBe('2026-07-16T10:00:00.000Z');
  });

  it('list() devuelve newest-first (createdAt DESC)', async () => {
    let t = new Date('2026-07-16T10:00:00Z').getTime();
    const repo = new InMemoryRadiusSessionCureEventRepository({ now: () => new Date(t++) });
    await repo.record({ username: 'u1', trigger: 'auto', outcome: 'cured' });
    await repo.record({ username: 'u2', trigger: 'auto', outcome: 'skipped_alive' });
    const { items, total } = await repo.list({ page: 1, limit: 10 });
    expect(total).toBe(2);
    expect(items[0]?.username).toBe('u2');
    expect(items[1]?.username).toBe('u1');
  });

  it('list() filtra por outcome/trigger/username (contains, case-insensitive)', async () => {
    const repo = new InMemoryRadiusSessionCureEventRepository();
    await repo.record({ username: 'PerezJuan', trigger: 'auto', outcome: 'cured' });
    await repo.record({ username: 'GomezAna', trigger: 'manual', outcome: 'failed' });
    const byOutcome = await repo.list({ page: 1, limit: 10, outcome: 'failed' });
    expect(byOutcome.items).toHaveLength(1);
    expect(byOutcome.items[0]?.username).toBe('GomezAna');

    const byUsername = await repo.list({ page: 1, limit: 10, username: 'perez' });
    expect(byUsername.items).toHaveLength(1);
    expect(byUsername.items[0]?.username).toBe('PerezJuan');
  });

  it('list() usernameExact gana sobre username contains y matchea IGUALDAD (bug perez1/perez10)', async () => {
    const repo = new InMemoryRadiusSessionCureEventRepository();
    await repo.record({ username: 'perez1', trigger: 'auto', outcome: 'cured' });
    await repo.record({ username: 'perez10', trigger: 'auto', outcome: 'cured' });
    const { items } = await repo.list({ page: 1, limit: 10, usernameExact: 'perez1' });
    expect(items).toHaveLength(1);
    expect(items[0]?.username).toBe('perez1');
  });

  it('list() filtra por from/to (createdAt)', async () => {
    const repo = new InMemoryRadiusSessionCureEventRepository({ now: () => new Date('2026-07-16T10:00:00Z') });
    await repo.record({ username: 'u1', trigger: 'auto', outcome: 'cured' });
    const before = await repo.list({ page: 1, limit: 10, from: new Date('2026-07-16T11:00:00Z') });
    expect(before.items).toHaveLength(0);
    const after = await repo.list({ page: 1, limit: 10, from: new Date('2026-07-16T09:00:00Z') });
    expect(after.items).toHaveLength(1);
  });

  it('countByOutcome() ignora el filtro outcome (desglose completo)', async () => {
    const repo = new InMemoryRadiusSessionCureEventRepository();
    await repo.record({ username: 'u1', trigger: 'auto', outcome: 'cured' });
    await repo.record({ username: 'u1', trigger: 'auto', outcome: 'cured' });
    await repo.record({ username: 'u2', trigger: 'auto', outcome: 'skipped_alive' });
    const counts = await repo.countByOutcome({});
    expect(counts['cured']).toBe(2);
    expect(counts['skipped_alive']).toBe(1);
  });
});
