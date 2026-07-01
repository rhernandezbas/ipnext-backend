/**
 * ListPppoeNasMoveEvents use case — TDD tests (pppoe-move-nas W1, design D6 punto 3).
 *
 * Wire contract (campo por campo):
 *   { items: [{ id, username, fromNas: {id,name}|null, toNas: {id,name}|null, fromIp, toIp,
 *               trigger, outcome, reason, actorName, createdAt }], total, page, limit }
 *
 * Escenarios: paginado (page/limit, clamp limit≤100), filtros outcome/trigger/username (S10.4),
 * resolución de nombres de NAS (id → name; NAS borrado → fallback al id), orden newest-first.
 */
import { ListPppoeNasMoveEvents } from '@application/use-cases/ListPppoeNasMoveEvents';
import { InMemoryPppoeNasMoveEventRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeNasMoveEventRepository';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import type { RecordPppoeNasMoveEventInput } from '@domain/ports/PppoeNasMoveEventRepository';

function baseEvent(overrides: Partial<RecordPppoeNasMoveEventInput> = {}): RecordPppoeNasMoveEventInput {
  return {
    username: 'user1',
    pppoeServiceId: 'svc-1',
    fromNasId: '1',
    toNasId: '3',
    fromIp: '100.64.60.25',
    toIp: '100.64.43.3',
    trigger: 'manual',
    outcome: 'moved',
    reason: null,
    actorName: 'operador',
    ...overrides,
  };
}

describe('ListPppoeNasMoveEvents', () => {
  let repo: InMemoryPppoeNasMoveEventRepository;
  let nasRepo: InMemoryNasRepository;
  let uc: ListPppoeNasMoveEvents;
  let tick: number;

  beforeEach(() => {
    tick = 0;
    repo = new InMemoryPppoeNasMoveEventRepository({
      now: () => new Date(Date.UTC(2026, 6, 1, 12, 0, tick++)),
    });
    nasRepo = new InMemoryNasRepository();
    uc = new ListPppoeNasMoveEvents(repo, nasRepo);
  });

  it('wire contract campo por campo: items + total + page + limit', async () => {
    await repo.record(baseEvent());

    const page = await uc.execute({});

    expect(page.total).toBe(1);
    expect(page.page).toBe(1);
    expect(page.limit).toBe(20); // default
    expect(page.items).toHaveLength(1);
    const item = page.items[0];
    expect(Object.keys(item).sort()).toEqual(
      ['actorName', 'createdAt', 'fromIp', 'fromNas', 'id', 'outcome', 'reason', 'toIp', 'toNas', 'trigger', 'username'],
    );
    expect(item.username).toBe('user1');
    // fromNas/toNas resueltos {id, name} contra el inventario NAS (seed: '1' MikroTik central, '3' MikroTik sucursal).
    expect(item.fromNas).toEqual({ id: '1', name: 'MikroTik central' });
    expect(item.toNas).toEqual({ id: '3', name: 'MikroTik sucursal' });
    expect(item.fromIp).toBe('100.64.60.25');
    expect(item.toIp).toBe('100.64.43.3');
    expect(item.trigger).toBe('manual');
    expect(item.outcome).toBe('moved');
    expect(item.reason).toBeNull();
    expect(item.actorName).toBe('operador');
    expect(typeof item.id).toBe('string');
    expect(typeof item.createdAt).toBe('string');
  });

  it('fromNas null cuando fromNasId es null; NAS borrado → name cae al id (no revienta)', async () => {
    await repo.record(baseEvent({ fromNasId: null, toNasId: 'nas-borrado' }));

    const page = await uc.execute({});

    expect(page.items[0].fromNas).toBeNull();
    expect(page.items[0].toNas).toEqual({ id: 'nas-borrado', name: 'nas-borrado' });
  });

  it('orden newest-first', async () => {
    await repo.record(baseEvent({ username: 'viejo' }));
    await repo.record(baseEvent({ username: 'nuevo' }));

    const page = await uc.execute({});
    expect(page.items.map(i => i.username)).toEqual(['nuevo', 'viejo']);
  });

  it('paginado: page/limit con total del filtro completo', async () => {
    for (let i = 0; i < 5; i++) await repo.record(baseEvent({ username: `u${i}` }));

    const page2 = await uc.execute({ page: 2, limit: 2 });
    expect(page2.total).toBe(5);
    expect(page2.page).toBe(2);
    expect(page2.limit).toBe(2);
    expect(page2.items).toHaveLength(2);
    // newest-first: u4 u3 | u2 u1 | u0
    expect(page2.items.map(i => i.username)).toEqual(['u2', 'u1']);
  });

  it('limit se clampea a 100 (y page mínimo 1)', async () => {
    await repo.record(baseEvent());
    const page = await uc.execute({ page: 0, limit: 500 });
    expect(page.limit).toBe(100);
    expect(page.page).toBe(1);
  });

  it('S10.4: filtro por outcome devuelve SOLO ese outcome (y el total refleja el filtro)', async () => {
    await repo.record(baseEvent({ outcome: 'moved' }));
    await repo.record(baseEvent({ outcome: 'failed_no_free_ip', toIp: null }));
    await repo.record(baseEvent({ outcome: 'failed_no_free_ip', toIp: null }));

    const page = await uc.execute({ outcome: 'failed_no_free_ip' });
    expect(page.total).toBe(2);
    expect(page.items.every(i => i.outcome === 'failed_no_free_ip')).toBe(true);
  });

  it('filtro por trigger', async () => {
    await repo.record(baseEvent({ trigger: 'manual' }));
    await repo.record(baseEvent({ trigger: 'auto', actorName: 'sistema' }));

    const page = await uc.execute({ trigger: 'auto' });
    expect(page.total).toBe(1);
    expect(page.items[0].trigger).toBe('auto');
  });

  it('filtro por username: coincidencia parcial case-insensitive', async () => {
    await repo.record(baseEvent({ username: 'juan.perez' }));
    await repo.record(baseEvent({ username: 'maria.lopez' }));

    const page = await uc.execute({ username: 'PEREZ' });
    expect(page.total).toBe(1);
    expect(page.items[0].username).toBe('juan.perez');
  });
});
