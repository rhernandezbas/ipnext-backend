/**
 * pppoe-foundation — InMemoryPppoeServiceRepository unit tests.
 * Cubre: upsert idempotente por username, registros sin contrato (contractId null),
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
    expect(typeof s.createdAt).toBe('string');
  });

  it('upsert es idempotente por username: actualiza, NO duplica', async () => {
    await repo.upsertByUsername({ username: 'u1', password: 'p1', nasId: 'nas1', profile: 'IP-Air-30-10' });
    const updated = await repo.upsertByUsername({
      username: 'u1', password: 'p2', nasId: 'nas1', profile: 'IP-REDUCCION', contractId: 'C1',
    });
    const all = await repo.list();
    expect(all).toHaveLength(1);
    expect(updated.password).toBe('p2');
    expect(updated.profile).toBe('IP-REDUCCION');
    expect(updated.contractId).toBe('C1');
  });

  it('persiste registro sin contrato (contractId null)', async () => {
    const s = await repo.upsertByUsername({
      username: 'sin-contrato', password: 'p', nasId: 'nas1', contractId: null,
    });
    expect(s.contractId).toBeNull();
    expect(await repo.findByUsername('sin-contrato')).not.toBeNull();
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

  it('findUnassigned devuelve SOLO los huérfanos (contractId null)', async () => {
    await repo.upsertByUsername({ username: 'orphan1', password: 'p', nasId: 'n1', contractId: null });
    await repo.upsertByUsername({ username: 'orphan2', password: 'p', nasId: 'n1' }); // default null
    await repo.upsertByUsername({ username: 'asociado', password: 'p', nasId: 'n1', contractId: 'C1' });
    const orphans = await repo.findUnassigned();
    expect(orphans.map(s => s.username).sort()).toEqual(['orphan1', 'orphan2']);
  });

  it('listAllPaginated EXCLUYE huérfanos (contractId null): data y total cuentan SOLO los con contrato', async () => {
    await repo.upsertByUsername({ username: 'orphan', password: 'p', nasId: 'n1', contractId: null });
    await repo.upsertByUsername({ username: 'cliente', password: 'p', nasId: 'n1', contractId: 'C1' });
    const { data, total } = await repo.listAllPaginated({ page: 1, pageSize: 10 });
    expect(total).toBe(1);
    expect(data).toHaveLength(1);
    expect(data[0]!.username).toBe('cliente');
  });

  // ── pppoe-bulk-select-filter (v2) — listAllIds (tasks 1.4/1.5) ────────────────────────
  describe('listAllIds', () => {
    it('SIN filtro (includeUnassigned default false): excluye huérfanos, ids.length === total', async () => {
      await repo.upsertByUsername({ username: 'orphan', password: 'p', nasId: 'n1', contractId: null });
      await repo.upsertByUsername({ username: 'a', password: 'p', nasId: 'n1', contractId: 'C1' });
      await repo.upsertByUsername({ username: 'b', password: 'p', nasId: 'n1', contractId: 'C2' });

      const { ids, total } = await repo.listAllIds({});
      expect(total).toBe(2);
      expect(ids.length).toBe(total);
      expect(ids.sort()).toEqual([
        (await repo.findByUsername('a'))!.id,
        (await repo.findByUsername('b'))!.id,
      ].sort());
    });

    it('includeUnassigned=true: incluye huérfanos', async () => {
      await repo.upsertByUsername({ username: 'orphan', password: 'p', nasId: 'n1', contractId: null });
      await repo.upsertByUsername({ username: 'a', password: 'p', nasId: 'n1', contractId: 'C1' });

      const { ids, total } = await repo.listAllIds({ includeUnassigned: true });
      expect(total).toBe(2);
      expect(ids.length).toBe(2);
    });

    it('filtra por nasId', async () => {
      const s1 = await repo.upsertByUsername({ username: 'a', password: 'p', nasId: 'nas-1', contractId: 'C1' });
      await repo.upsertByUsername({ username: 'b', password: 'p', nasId: 'nas-2', contractId: 'C2' });

      const { ids, total } = await repo.listAllIds({ nasId: 'nas-1', includeUnassigned: true });
      expect(total).toBe(1);
      expect(ids).toEqual([s1.id]);
    });

    it('filtra por search (username)', async () => {
      const s1 = await repo.upsertByUsername({ username: 'juan', password: 'p', nasId: 'n1', contractId: 'C1' });
      await repo.upsertByUsername({ username: 'pedro', password: 'p', nasId: 'n1', contractId: 'C2' });

      const { ids, total } = await repo.listAllIds({ search: 'jua', includeUnassigned: true });
      expect(total).toBe(1);
      expect(ids).toEqual([s1.id]);
    });

    it('filtra por displayStatus (reduced)', async () => {
      await repo.upsertByUsername({ username: 'a', password: 'p', nasId: 'n1', status: 'enabled', enforcedState: 'active', contractId: 'C1' });
      const s2 = await repo.upsertByUsername({ username: 'b', password: 'p', nasId: 'n1', status: 'enabled', enforcedState: 'reduced', contractId: 'C2' });

      const { ids, total } = await repo.listAllIds({ displayStatus: 'reduced', includeUnassigned: true });
      expect(total).toBe(1);
      expect(ids).toEqual([s2.id]);
    });

    it('combinación nasId + search + displayStatus (AND de los tres)', async () => {
      const match = await repo.upsertByUsername({ username: 'juan', password: 'p', nasId: 'nas-1', status: 'enabled', enforcedState: 'active', contractId: 'C1' });
      // Mismo nasId + search, pero status distinto → no matchea.
      await repo.upsertByUsername({ username: 'juanito', password: 'p', nasId: 'nas-1', status: 'enabled', enforcedState: 'reduced', contractId: 'C2' });
      // Mismo search + status, pero otro NAS → no matchea.
      await repo.upsertByUsername({ username: 'juanma', password: 'p', nasId: 'nas-2', status: 'enabled', enforcedState: 'active', contractId: 'C3' });

      const { ids, total } = await repo.listAllIds({
        nasId: 'nas-1', search: 'juan', displayStatus: 'active', includeUnassigned: true,
      });
      expect(total).toBe(1);
      expect(ids).toEqual([match.id]);
    });

    it('sin match: ids vacío, total 0 (no es un smoke test — hay filas que NO matchean el filtro)', async () => {
      await repo.upsertByUsername({ username: 'a', password: 'p', nasId: 'nas-1', contractId: 'C1' });
      const { ids, total } = await repo.listAllIds({ nasId: 'nas-inexistente', includeUnassigned: true });
      expect(ids).toEqual([]);
      expect(total).toBe(0);
    });
  });

  // ── pppoe-preprovision D7.3 — setNasAndIp condicional (CAS por nasId, espejo del Prisma) ──
  describe('setNasAndIp condicional (D7.3)', () => {
    it('expectedNasId=null + fila PENDIENTE (nasId null) → el update aplica (adopción gana la carrera)', async () => {
      const s = await repo.upsertByUsername({ username: 'pend', password: 'p', nasId: null });

      const updated = await repo.setNasAndIp(s.id, 'nas-1', '100.64.43.3', 'fixed', null);

      expect(updated).not.toBeNull();
      expect(updated!.nasId).toBe('nas-1');
      expect(updated!.remoteAddress).toBe('100.64.43.3');
    });

    it('expectedNasId=null + fila YA adoptada (nasId seteado) → null y la fila queda INTACTA (CAS no matchea)', async () => {
      const s = await repo.upsertByUsername({
        username: 'pend', password: 'p', nasId: 'nas-ganador', remoteAddress: '100.64.43.9',
      });

      const updated = await repo.setNasAndIp(s.id, 'nas-perdedor', '100.64.43.3', 'fixed', null);

      expect(updated).toBeNull();
      const row = await repo.findById(s.id);
      expect(row!.nasId).toBe('nas-ganador');
      expect(row!.remoteAddress).toBe('100.64.43.9');
    });

    it('SIN expectedNasId → comportamiento actual intacto (update incondicional por id)', async () => {
      const s = await repo.upsertByUsername({
        username: 'u1', password: 'p', nasId: 'nas-viejo', remoteAddress: '100.64.43.9',
      });

      const updated = await repo.setNasAndIp(s.id, 'nas-nuevo', '100.64.43.3', 'fixed');

      expect(updated).not.toBeNull();
      expect(updated!.nasId).toBe('nas-nuevo');
    });
  });
});
