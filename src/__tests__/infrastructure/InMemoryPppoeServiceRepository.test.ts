/**
 * pppoe-foundation — InMemoryPppoeServiceRepository unit tests.
 * Cubre spec pppoe-inventory: upsert idempotente por username, huérfanos (contractId null),
 * findByContract multi-contrato, defaults.
 */
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';

describe('InMemoryPppoeServiceRepository', () => {
  let repo: InMemoryPppoeServiceRepository;

  beforeEach(() => {
    repo = new InMemoryPppoeServiceRepository();
  });

  it('upsert crea una fila con defaults (status=enabled, nullables en null)', async () => {
    const s = await repo.upsertByUsername({ username: 'u1', password: 'p', nasId: 'nas1' });
    expect(s.id).toBeDefined();
    expect(s.username).toBe('u1');
    expect(s.status).toBe('enabled');
    expect(s.profile).toBeNull();
    expect(s.remoteAddress).toBeNull();
    expect(s.contractId).toBeNull();
    expect(s.matchMethod).toBeNull();
    expect(typeof s.createdAt).toBe('string');
  });

  it('upsert es idempotente por username: actualiza, NO duplica', async () => {
    await repo.upsertByUsername({ username: 'u1', password: 'p1', nasId: 'nas1', profile: 'IP-Air-30-10' });
    const updated = await repo.upsertByUsername({
      username: 'u1', password: 'p2', nasId: 'nas1',
      profile: 'IP-REDUCCION', contractId: 'C1', matchMethod: 'username',
    });
    const all = await repo.list();
    expect(all).toHaveLength(1);
    expect(updated.password).toBe('p2');
    expect(updated.profile).toBe('IP-REDUCCION');
    expect(updated.contractId).toBe('C1');
    expect(updated.matchMethod).toBe('username');
  });

  it('persiste huérfano (contractId null, matchMethod orphan)', async () => {
    const s = await repo.upsertByUsername({
      username: 'agote-x', password: 'p', nasId: 'nas1', contractId: null, matchMethod: 'orphan',
    });
    expect(s.contractId).toBeNull();
    expect(s.matchMethod).toBe('orphan');
    expect(await repo.findByUsername('agote-x')).not.toBeNull();
  });

  it('findByContract devuelve todas las filas del contrato (multi-contrato seguro)', async () => {
    await repo.upsertByUsername({ username: 'a', password: 'p', nasId: 'n1', contractId: 'C1' });
    await repo.upsertByUsername({ username: 'b', password: 'p', nasId: 'n2', contractId: 'C1' });
    await repo.upsertByUsername({ username: 'c', password: 'p', nasId: 'n1', contractId: 'C2' });
    const c1 = await repo.findByContract('C1');
    expect(c1).toHaveLength(2);
    expect(c1.map(s => s.username).sort()).toEqual(['a', 'b']);
  });

  it('findByUsername devuelve null si no existe', async () => {
    expect(await repo.findByUsername('nope')).toBeNull();
  });
});
