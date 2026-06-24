import { InMemoryRadiusAuthEventRepository } from '@infrastructure/adapters/in-memory/InMemoryRadiusAuthEventRepository';
import type { RadiusAuthEventUpsert } from '@domain/ports/RadiusAuthEventRepository';

function row(overrides: Partial<RadiusAuthEventUpsert> = {}): RadiusAuthEventUpsert {
  return {
    sourceUniqueId: 'pa-001',
    username:       'u1',
    reply:         'Access-Reject',
    authdate:      new Date('2026-06-22T10:00:00Z'),
    class:         null,
    ...overrides,
  };
}

describe('InMemoryRadiusAuthEventRepository', () => {
  it('upsertMany inserta filas nuevas', async () => {
    const repo = new InMemoryRadiusAuthEventRepository();
    const n = await repo.upsertMany([row()]);
    expect(n).toBe(1);
    const stored = await repo.list({ page: 1, pageSize: 10 });
    expect(stored.total).toBe(1);
    expect(stored.data[0].sourceUniqueId).toBe('pa-001');
    expect(stored.data[0].id).toBeTruthy();
  });

  it('upsertMany es idempotente por sourceUniqueId', async () => {
    const repo = new InMemoryRadiusAuthEventRepository();
    await repo.upsertMany([row()]);
    await repo.upsertMany([row({ class: 'NEW-CLASS' })]);
    const stored = await repo.list({ page: 1, pageSize: 10 });
    expect(stored.total).toBe(1);
    expect(stored.data[0].class).toBe('NEW-CLASS');
  });

  it('preserva el id en re-upsert (no genera uno nuevo)', async () => {
    const repo = new InMemoryRadiusAuthEventRepository();
    await repo.upsertMany([row()]);
    const before = (await repo.list({ page: 1, pageSize: 10 })).data[0].id;
    await repo.upsertMany([row()]);
    const after = (await repo.list({ page: 1, pageSize: 10 })).data[0].id;
    expect(after).toBe(before);
  });

  it('list filtra por reply', async () => {
    const repo = new InMemoryRadiusAuthEventRepository();
    await repo.upsertMany([
      row({ sourceUniqueId: 'a', reply: 'Access-Accept' }),
      row({ sourceUniqueId: 'b', reply: 'Access-Reject' }),
    ]);
    const res = await repo.list({ reply: 'Access-Reject', page: 1, pageSize: 10 });
    expect(res.total).toBe(1);
    expect(res.data[0].sourceUniqueId).toBe('b');
  });

  it('list ordena authdate DESC', async () => {
    const repo = new InMemoryRadiusAuthEventRepository();
    await repo.upsertMany([
      row({ sourceUniqueId: 'old', authdate: new Date('2026-06-01T00:00:00Z') }),
      row({ sourceUniqueId: 'new', authdate: new Date('2026-06-20T00:00:00Z') }),
    ]);
    const res = await repo.list({ page: 1, pageSize: 10 });
    expect(res.data.map(e => e.sourceUniqueId)).toEqual(['new', 'old']);
  });

  it('deleteOlderThan borra por authdate < cutoff respetando batchSize', async () => {
    const repo = new InMemoryRadiusAuthEventRepository();
    await repo.upsertMany([
      row({ sourceUniqueId: 'old1', authdate: new Date('2020-01-01T00:00:00Z') }),
      row({ sourceUniqueId: 'old2', authdate: new Date('2020-01-02T00:00:00Z') }),
      row({ sourceUniqueId: 'fresh', authdate: new Date('2026-06-01T00:00:00Z') }),
    ]);
    const deleted = await repo.deleteOlderThan(new Date('2025-01-01T00:00:00Z'), 10);
    expect(deleted).toBe(2);
    const ids = (await repo.list({ page: 1, pageSize: 10 })).data.map(e => e.sourceUniqueId);
    expect(ids).toEqual(['fresh']);
  });
});
