import { InMemoryRadiusEventRepository } from '@infrastructure/adapters/in-memory/InMemoryRadiusEventRepository';
import { RadiusEventUpsert } from '@domain/ports/RadiusEventRepository';

function makeRow(overrides: Partial<RadiusEventUpsert> = {}): RadiusEventUpsert {
  return {
    sourceUniqueId: 'uid-001',
    username: 'cliente001',
    nasIpAddress: '10.75.0.30',
    nasId: 'nas-1',
    framedIp: '100.64.1.2',
    macAddress: 'AA:BB:CC:DD:EE:FF',
    vlanId: 3713,
    startedAt: new Date('2026-06-22T10:00:00Z'),
    stoppedAt: null,
    sessionTime: null,
    bytesIn: BigInt(1024),
    bytesOut: BigInt(2048),
    eventType: 'start',
    status: 'online',
    ...overrides,
  };
}

describe('InMemoryRadiusEventRepository', () => {
  describe('upsertMany — idempotencia por sourceUniqueId', () => {
    it('inserta un evento nuevo', async () => {
      const repo = new InMemoryRadiusEventRepository();
      const count = await repo.upsertMany([makeRow()]);
      expect(count).toBe(1);
    });

    it('el mismo sourceUniqueId no duplica — segunda llamada actualiza en vez de insertar', async () => {
      const repo = new InMemoryRadiusEventRepository();
      await repo.upsertMany([makeRow({ sourceUniqueId: 'uid-001', status: 'online', stoppedAt: null })]);
      await repo.upsertMany([makeRow({
        sourceUniqueId: 'uid-001',
        status: 'closed',
        stoppedAt: new Date('2026-06-22T10:45:00Z'),
        eventType: 'stop',
        sessionTime: 2700,
      })]);

      const result = await repo.list({ page: 1, pageSize: 10 });
      expect(result.total).toBe(1);
      expect(result.data[0].status).toBe('closed');
      expect(result.data[0].stoppedAt).toBe('2026-06-22T10:45:00.000Z');
      expect(result.data[0].eventType).toBe('stop');
    });

    it('múltiples rows con diferentes sourceUniqueId → se insertan todos', async () => {
      const repo = new InMemoryRadiusEventRepository();
      const rows = [
        makeRow({ sourceUniqueId: 'uid-001' }),
        makeRow({ sourceUniqueId: 'uid-002', username: 'cliente002' }),
        makeRow({ sourceUniqueId: 'uid-003', username: 'cliente003' }),
      ];
      const count = await repo.upsertMany(rows);
      expect(count).toBe(3);
      const result = await repo.list({ page: 1, pageSize: 10 });
      expect(result.total).toBe(3);
    });

    it('array vacío → 0', async () => {
      const repo = new InMemoryRadiusEventRepository();
      const count = await repo.upsertMany([]);
      expect(count).toBe(0);
    });
  });

  describe('list — filtros', () => {
    async function seededRepo() {
      const repo = new InMemoryRadiusEventRepository();
      await repo.upsertMany([
        makeRow({ sourceUniqueId: 'u1', username: 'alice', nasId: 'nas-1', vlanId: 100, status: 'online',  startedAt: new Date('2026-06-20T08:00:00Z') }),
        makeRow({ sourceUniqueId: 'u2', username: 'bob',   nasId: 'nas-1', vlanId: 200, status: 'closed',  startedAt: new Date('2026-06-21T09:00:00Z'), stoppedAt: new Date('2026-06-21T10:00:00Z'), eventType: 'stop' }),
        makeRow({ sourceUniqueId: 'u3', username: 'alice', nasId: 'nas-2', vlanId: 100, status: 'closed',  startedAt: new Date('2026-06-22T07:00:00Z'), stoppedAt: new Date('2026-06-22T08:00:00Z'), eventType: 'stop' }),
      ]);
      return repo;
    }

    it('sin filtros devuelve todo paginado', async () => {
      const repo = await seededRepo();
      const result = await repo.list({ page: 1, pageSize: 10 });
      expect(result.total).toBe(3);
      expect(result.data).toHaveLength(3);
    });

    it('filtra por username', async () => {
      const repo = await seededRepo();
      const result = await repo.list({ username: 'alice', page: 1, pageSize: 10 });
      expect(result.total).toBe(2);
      result.data.forEach((e) => expect(e.username).toBe('alice'));
    });

    it('filtra por nasId', async () => {
      const repo = await seededRepo();
      const result = await repo.list({ nasId: 'nas-1', page: 1, pageSize: 10 });
      expect(result.total).toBe(2);
      result.data.forEach((e) => expect(e.nasId).toBe('nas-1'));
    });

    it('filtra por vlanId', async () => {
      const repo = await seededRepo();
      const result = await repo.list({ vlanId: 200, page: 1, pageSize: 10 });
      expect(result.total).toBe(1);
      expect(result.data[0].username).toBe('bob');
    });

    it('filtra por status online', async () => {
      const repo = await seededRepo();
      const result = await repo.list({ status: 'online', page: 1, pageSize: 10 });
      expect(result.total).toBe(1);
      expect(result.data[0].username).toBe('alice');
      expect(result.data[0].status).toBe('online');
    });

    it('filtra por status closed', async () => {
      const repo = await seededRepo();
      const result = await repo.list({ status: 'closed', page: 1, pageSize: 10 });
      expect(result.total).toBe(2);
    });

    it('filtra por from (startedAt >=)', async () => {
      const repo = await seededRepo();
      const result = await repo.list({ from: new Date('2026-06-21T00:00:00Z'), page: 1, pageSize: 10 });
      expect(result.total).toBe(2);
    });

    it('filtra por to (startedAt <=)', async () => {
      const repo = await seededRepo();
      const result = await repo.list({ to: new Date('2026-06-20T23:59:59Z'), page: 1, pageSize: 10 });
      expect(result.total).toBe(1);
      expect(result.data[0].username).toBe('alice');
    });

    it('paginación — page 1 de pageSize 2', async () => {
      const repo = await seededRepo();
      const result = await repo.list({ page: 1, pageSize: 2 });
      expect(result.data).toHaveLength(2);
      expect(result.total).toBe(3);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(2);
    });

    it('paginación — page 2 de pageSize 2 devuelve el resto', async () => {
      const repo = await seededRepo();
      const result = await repo.list({ page: 2, pageSize: 2 });
      expect(result.data).toHaveLength(1);
    });

    it('combina filtros username + status', async () => {
      const repo = await seededRepo();
      const result = await repo.list({ username: 'alice', status: 'closed', page: 1, pageSize: 10 });
      expect(result.total).toBe(1);
      expect(result.data[0].nasId).toBe('nas-2');
    });
  });

  describe('lastEventByUsername', () => {
    it('devuelve el resumen con el startedAt más reciente por username en el nasId dado', async () => {
      const repo = new InMemoryRadiusEventRepository();
      await repo.upsertMany([
        makeRow({ sourceUniqueId: 'u1', username: 'alice', nasId: 'nas-1', startedAt: new Date('2026-06-20T08:00:00Z'), stoppedAt: new Date('2026-06-20T09:00:00Z'), status: 'closed', eventType: 'stop' }),
        makeRow({ sourceUniqueId: 'u2', username: 'alice', nasId: 'nas-1', startedAt: new Date('2026-06-22T12:00:00Z'), stoppedAt: null, status: 'online' }),
        makeRow({ sourceUniqueId: 'u3', username: 'bob',   nasId: 'nas-1', startedAt: new Date('2026-06-21T09:00:00Z'), stoppedAt: null, status: 'online' }),
        // diferente nasId → no debe aparecer para nasId=nas-1
        makeRow({ sourceUniqueId: 'u4', username: 'alice', nasId: 'nas-2', startedAt: new Date('2026-06-23T00:00:00Z') }),
      ]);

      const result = await repo.lastEventByUsername('nas-1', ['alice', 'bob']);
      expect(result.size).toBe(2);
      // alice: lastStartedAt = u2 (el más reciente), currentlyOnline = true (u2 activo)
      const aliceSummary = result.get('alice');
      expect(aliceSummary?.lastStartedAt).toBe('2026-06-22T12:00:00.000Z');
      expect(aliceSummary?.currentlyOnline).toBe(true);
      // lastStoppedAt = stoppedAt del último cerrado (u1)
      expect(aliceSummary?.lastStoppedAt).toBe('2026-06-20T09:00:00.000Z');

      // bob: solo un evento online
      const bobSummary = result.get('bob');
      expect(bobSummary?.lastStartedAt).toBe('2026-06-21T09:00:00.000Z');
      expect(bobSummary?.currentlyOnline).toBe(true);
      expect(bobSummary?.lastStoppedAt).toBeNull();
    });

    it('username sin eventos en el nasId → no aparece en el map', async () => {
      const repo = new InMemoryRadiusEventRepository();
      await repo.upsertMany([makeRow({ sourceUniqueId: 'u1', username: 'alice', nasId: 'nas-1' })]);
      const result = await repo.lastEventByUsername('nas-1', ['alice', 'charlie']);
      expect(result.has('charlie')).toBe(false);
      expect(result.has('alice')).toBe(true);
    });

    it('array de usernames vacío → map vacío', async () => {
      const repo = new InMemoryRadiusEventRepository();
      await repo.upsertMany([makeRow()]);
      const result = await repo.lastEventByUsername('nas-1', []);
      expect(result.size).toBe(0);
    });
  });

  describe('deleteOlderThan', () => {
    it('borra eventos con startedAt < cutoff y devuelve el count', async () => {
      const repo = new InMemoryRadiusEventRepository();
      await repo.upsertMany([
        makeRow({ sourceUniqueId: 'old-1', startedAt: new Date('2025-01-01T00:00:00Z') }),
        makeRow({ sourceUniqueId: 'old-2', startedAt: new Date('2025-06-01T00:00:00Z') }),
        makeRow({ sourceUniqueId: 'new-1', startedAt: new Date('2026-06-22T00:00:00Z') }),
      ]);

      const deleted = await repo.deleteOlderThan(new Date('2026-01-01T00:00:00Z'), 1000);
      expect(deleted).toBe(2);

      const result = await repo.list({ page: 1, pageSize: 10 });
      expect(result.total).toBe(1);
      expect(result.data[0].sourceUniqueId).toBe('new-1');
    });

    it('FIX6: batchSize limita cuántos borrar por llamada (fidelidad con Prisma)', async () => {
      // FIX6: el InMemory ahora respeta batchSize (igual que Prisma).
      // Esto permite que el use case detecte "hay más" cuando deleted === batchSize
      // y lo use para el cap de maxBatchesPerTick.
      const repo = new InMemoryRadiusEventRepository();
      await repo.upsertMany([
        makeRow({ sourceUniqueId: 'old-1', startedAt: new Date('2025-01-01T00:00:00Z') }),
        makeRow({ sourceUniqueId: 'old-2', startedAt: new Date('2025-06-01T00:00:00Z') }),
      ]);

      // Con batchSize=1, solo borra 1 en esta llamada
      const deleted1 = await repo.deleteOlderThan(new Date('2026-01-01T00:00:00Z'), 1);
      expect(deleted1).toBe(1);
      // La segunda llamada borra el restante
      const deleted2 = await repo.deleteOlderThan(new Date('2026-01-01T00:00:00Z'), 1);
      expect(deleted2).toBe(1);
      // No quedan más viejos
      const deleted3 = await repo.deleteOlderThan(new Date('2026-01-01T00:00:00Z'), 1);
      expect(deleted3).toBe(0);
    });

    it('sin eventos que borrar → 0', async () => {
      const repo = new InMemoryRadiusEventRepository();
      await repo.upsertMany([makeRow({ startedAt: new Date('2026-06-22T00:00:00Z') })]);
      const deleted = await repo.deleteOlderThan(new Date('2025-01-01T00:00:00Z'), 1000);
      expect(deleted).toBe(0);
    });
  });

  // ── FIX 7: fidelidad de campos inmutables en upsert ─────────────────────────
  // BUG: InMemoryRadiusEventRepository sobreescribía username/nasIpAddress/startedAt en update.
  // Prisma NO los incluye en el update block (son identidad de la sesion, inmutables).
  // FIX: en update, NO pisar username/nasIpAddress/startedAt.

  describe('upsertMany — campos inmutables no se pisan en update (FIX7)', () => {
    it('FIX7: re-upsert con username distinto NO cambia el username almacenado', async () => {
      const repo = new InMemoryRadiusEventRepository();
      await repo.upsertMany([makeRow({ sourceUniqueId: 'uid-fix7', username: 'original-user' })]);
      // Re-upsert con username diferente (simulando dato corrupto)
      await repo.upsertMany([makeRow({ sourceUniqueId: 'uid-fix7', username: 'different-user', status: 'closed', stoppedAt: new Date('2026-06-22T11:00:00Z') })]);

      const result = await repo.list({ page: 1, pageSize: 10 });
      expect(result.total).toBe(1);
      // username NO debe cambiar (campo inmutable)
      expect(result.data[0].username).toBe('original-user');
      // status SÍ debe actualizarse
      expect(result.data[0].status).toBe('closed');
    });

    it('FIX7: re-upsert con startedAt distinto NO cambia el startedAt almacenado', async () => {
      const repo = new InMemoryRadiusEventRepository();
      const originalStartedAt = new Date('2026-06-22T10:00:00Z');
      await repo.upsertMany([makeRow({ sourceUniqueId: 'uid-fix7b', startedAt: originalStartedAt })]);
      // Re-upsert con startedAt diferente (simulando dato corrupto)
      await repo.upsertMany([makeRow({ sourceUniqueId: 'uid-fix7b', startedAt: new Date('2026-01-01T00:00:00Z'), stoppedAt: new Date('2026-06-22T11:00:00Z') })]);

      const result = await repo.list({ page: 1, pageSize: 10 });
      expect(result.total).toBe(1);
      // startedAt NO debe cambiar
      expect(result.data[0].startedAt).toBe(originalStartedAt.toISOString());
    });

    it('FIX7: re-upsert actualiza campos mutables (stoppedAt, status, bytesIn, bytesOut)', async () => {
      const repo = new InMemoryRadiusEventRepository();
      await repo.upsertMany([makeRow({ sourceUniqueId: 'uid-fix7c', status: 'online', stoppedAt: null, bytesIn: BigInt(100), bytesOut: BigInt(200) })]);
      await repo.upsertMany([makeRow({
        sourceUniqueId: 'uid-fix7c',
        status: 'closed',
        stoppedAt: new Date('2026-06-22T11:00:00Z'),
        sessionTime: 3600,
        bytesIn: BigInt(999),
        bytesOut: BigInt(1999),
        eventType: 'stop',
      })]);

      const result = await repo.list({ page: 1, pageSize: 10 });
      expect(result.data[0].status).toBe('closed');
      expect(result.data[0].stoppedAt).toBeTruthy();
      expect(result.data[0].sessionTime).toBe(3600);
      expect(result.data[0].bytesIn).toBe(BigInt(999));
      expect(result.data[0].bytesOut).toBe(BigInt(1999));
      expect(result.data[0].eventType).toBe('stop');
    });
  });
});
