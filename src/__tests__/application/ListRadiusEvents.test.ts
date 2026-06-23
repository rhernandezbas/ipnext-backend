/**
 * ListRadiusEvents.test.ts — TDD RED → GREEN
 *
 * Use case: ListRadiusEvents
 * Port: RadiusEventRepository (in-memory)
 * STRICT TDD MODE: este test DEBE fallar primero, luego implementar.
 */
import { ListRadiusEvents } from '@application/use-cases/ListRadiusEvents';
import { InMemoryRadiusEventRepository } from '@infrastructure/adapters/in-memory/InMemoryRadiusEventRepository';
import { RadiusEventDto } from '@application/dto/radius-event.dto';

// ── helpers ────────────────────────────────────────────────────────────────────

function makeRepo() {
  return new InMemoryRadiusEventRepository();
}

/** Siembra N eventos con campos controlables */
async function seedEvents(
  repo: InMemoryRadiusEventRepository,
  overrides: Array<Partial<{
    username: string;
    nasId: string | null;
    vlanId: number | null;
    status: 'online' | 'closed';
    eventType: 'start' | 'stop' | 'interim';
    startedAt: string;
    stoppedAt: string | null;
  }>>,
): Promise<void> {
  await repo.upsertMany(
    overrides.map((o, i) => ({
      sourceUniqueId: `uid-${i}`,
      username:       o.username ?? `user${i}`,
      nasIpAddress:   '10.75.0.30',
      nasId:          o.nasId ?? 'nas-1',
      framedIp:       null,
      macAddress:     null,
      vlanId:         o.vlanId ?? null,
      startedAt:      new Date(o.startedAt ?? `2026-06-${String(i + 1).padStart(2, '0')}T10:00:00Z`),
      stoppedAt:      o.stoppedAt ? new Date(o.stoppedAt) : null,
      sessionTime:    null,
      bytesIn:        BigInt(1024),
      bytesOut:       BigInt(2048),
      eventType:      o.eventType ?? 'start',
      status:         o.status ?? 'online',
    })),
  );
}

// ── suite ───────────────────────────────────────────────────────────────────────

describe('ListRadiusEvents', () => {
  // ── REQ-FILTER-1: sin filtros devuelve la primera página (default limit=50) ──
  it('sin filtros devuelve la primera página con datos', async () => {
    const repo = makeRepo();
    await seedEvents(repo, [{ username: 'c001' }, { username: 'c002' }]);
    const uc = new ListRadiusEvents(repo);

    const result = await uc.execute({});

    expect(result.data).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.page).toBe(1);
    expect(result.limit).toBe(50);
    expect(result.hasNext).toBe(false);
  });

  // ── REQ-FILTER-2: filtro username (substring, in-memory hace exact por ahora) ──
  it('filtra por username exacto', async () => {
    const repo = makeRepo();
    await seedEvents(repo, [
      { username: 'c001' },
      { username: 'c002' },
      { username: 'c001' },
    ]);
    const uc = new ListRadiusEvents(repo);

    const result = await uc.execute({ username: 'c001' });

    expect(result.total).toBe(2);
    result.data.forEach((d) => expect(d.username).toBe('c001'));
  });

  // ── REQ-FILTER-3: filtro nasId ────────────────────────────────────────────────
  it('filtra por nasId', async () => {
    const repo = makeRepo();
    await seedEvents(repo, [
      { nasId: 'nas-a' },
      { nasId: 'nas-b' },
      { nasId: 'nas-a' },
    ]);
    const uc = new ListRadiusEvents(repo);

    const result = await uc.execute({ nasId: 'nas-a' });

    expect(result.total).toBe(2);
    result.data.forEach((d) => expect(d.nasId).toBe('nas-a'));
  });

  // ── REQ-FILTER-4: filtro vlanId ──────────────────────────────────────────────
  it('filtra por vlanId', async () => {
    const repo = makeRepo();
    await seedEvents(repo, [
      { vlanId: 3713 },
      { vlanId: 3714 },
      { vlanId: 3713 },
    ]);
    const uc = new ListRadiusEvents(repo);

    const result = await uc.execute({ vlanId: 3713 });

    expect(result.total).toBe(2);
    result.data.forEach((d) => expect(d.vlanId).toBe(3713));
  });

  // ── REQ-FILTER-5: filtro from/to ─────────────────────────────────────────────
  it('filtra por rango de fechas from/to', async () => {
    const repo = makeRepo();
    await seedEvents(repo, [
      { startedAt: '2026-06-01T00:00:00Z' },
      { startedAt: '2026-06-10T00:00:00Z' },
      { startedAt: '2026-06-20T00:00:00Z' },
    ]);
    const uc = new ListRadiusEvents(repo);

    const result = await uc.execute({
      from: '2026-06-05T00:00:00Z',
      to:   '2026-06-15T00:00:00Z',
    });

    expect(result.total).toBe(1);
    expect(result.data[0].startedAt).toBe('2026-06-10T00:00:00.000Z');
  });

  // ── REQ-FILTER-7: online=true → solo stoppedAt=null ──────────────────────────
  it('online=true devuelve solo sesiones activas', async () => {
    const repo = makeRepo();
    await seedEvents(repo, [
      { status: 'online',  stoppedAt: null },
      { status: 'closed',  stoppedAt: '2026-06-10T12:00:00Z' },
      { status: 'online',  stoppedAt: null },
    ]);
    const uc = new ListRadiusEvents(repo);

    const result = await uc.execute({ online: true });

    expect(result.total).toBe(2);
    result.data.forEach((d) => expect(d.online).toBe(true));
  });

  it('online=false devuelve solo sesiones cerradas', async () => {
    const repo = makeRepo();
    await seedEvents(repo, [
      { status: 'online',  stoppedAt: null },
      { status: 'closed',  stoppedAt: '2026-06-10T12:00:00Z' },
    ]);
    const uc = new ListRadiusEvents(repo);

    const result = await uc.execute({ online: false });

    expect(result.total).toBe(1);
    result.data.forEach((d) => expect(d.online).toBe(false));
  });

  // ── REQ-FILTER-6: eventType ──────────────────────────────────────────────────
  it('filtra por eventType', async () => {
    const repo = makeRepo();
    await seedEvents(repo, [
      { eventType: 'start' },
      { eventType: 'stop'  },
      { eventType: 'start' },
    ]);
    const uc = new ListRadiusEvents(repo);

    const result = await uc.execute({ eventType: 'start' });

    expect(result.total).toBe(2);
    result.data.forEach((d) => expect(d.eventType).toBe('start'));
  });

  // ── REQ-PAGE-1: paginado ─────────────────────────────────────────────────────
  it('pagina correctamente', async () => {
    const repo = makeRepo();
    await seedEvents(repo, Array.from({ length: 10 }, (_, i) => ({ username: `u${i}` })));
    const uc = new ListRadiusEvents(repo);

    const page1 = await uc.execute({ page: 1, limit: 3 });
    const page2 = await uc.execute({ page: 2, limit: 3 });

    expect(page1.data).toHaveLength(3);
    expect(page1.total).toBe(10);
    expect(page1.hasNext).toBe(true);

    expect(page2.data).toHaveLength(3);
    expect(page2.hasNext).toBe(true);
  });

  // ── REQ-PAGE-1: limit cap a 200 ──────────────────────────────────────────────
  it('limit se capea a 200', async () => {
    const repo = makeRepo();
    const uc = new ListRadiusEvents(repo);
    // Si se pide 9999, el use case lo debe reducir a 200 (no explota)
    const result = await uc.execute({ limit: 9999 });
    expect(result.limit).toBe(200);
  });

  // ── REQ-PAGE-3: resultado vacío es válido ────────────────────────────────────
  it('resultado vacío retorna la estructura correcta', async () => {
    const repo = makeRepo();
    const uc = new ListRadiusEvents(repo);

    const result = await uc.execute({});

    expect(result).toEqual({
      data:    [],
      total:   0,
      page:    1,
      limit:   50,
      hasNext: false,
    });
  });

  // ── REQ-DTO-1: bytesIn/bytesOut como string, no BigInt ───────────────────────
  it('bytesIn y bytesOut son strings en el DTO', async () => {
    const repo = makeRepo();
    await seedEvents(repo, [{ username: 'c001' }]);
    const uc = new ListRadiusEvents(repo);

    const result = await uc.execute({ username: 'c001' });
    const dto = result.data[0] as RadiusEventDto;

    expect(typeof dto.inOctets).toBe('string');
    expect(typeof dto.outOctets).toBe('string');
    expect(dto.inOctets).toBe('1024');
    expect(dto.outOctets).toBe('2048');
  });

  // ── REQ-DTO-2: sourceUniqueId NO aparece en el DTO ───────────────────────────
  it('sourceUniqueId no aparece en el DTO', async () => {
    const repo = makeRepo();
    await seedEvents(repo, [{ username: 'c001' }]);
    const uc = new ListRadiusEvents(repo);

    const result = await uc.execute({ username: 'c001' });
    const dto = result.data[0] as RadiusEventDto;

    expect('sourceUniqueId' in dto).toBe(false);
  });

  // ── REQ-UC-2: orden default startedAt DESC ───────────────────────────────────
  it('ordena por startedAt DESC por defecto', async () => {
    const repo = makeRepo();
    await seedEvents(repo, [
      { startedAt: '2026-06-01T00:00:00Z', username: 'early' },
      { startedAt: '2026-06-20T00:00:00Z', username: 'late'  },
    ]);
    const uc = new ListRadiusEvents(repo);

    const result = await uc.execute({});

    expect(result.data[0].username).toBe('late');
    expect(result.data[1].username).toBe('early');
  });

  // ── FIX 3: paginación cruzada disjunta + orden DESC global ───────────────────
  // BUG: InMemory ordenaba ASC; el use case re-ordenaba solo la página → cross-página roto.
  // FIX: el repo ordena DESC antes de paginar; el use case NO re-ordena.

  it('FIX3: 5 eventos, limit=2 — page1 y page2 son DISJUNTOS y orden DESC', async () => {
    const repo = makeRepo();
    // Sembrar 5 eventos con startedAt distintos, en orden aleatorio
    await seedEvents(repo, [
      { startedAt: '2026-06-03T00:00:00Z', username: 'u3' },
      { startedAt: '2026-06-01T00:00:00Z', username: 'u1' },
      { startedAt: '2026-06-05T00:00:00Z', username: 'u5' },
      { startedAt: '2026-06-02T00:00:00Z', username: 'u2' },
      { startedAt: '2026-06-04T00:00:00Z', username: 'u4' },
    ]);
    const uc = new ListRadiusEvents(repo);

    const page1 = await uc.execute({ page: 1, limit: 2 });
    const page2 = await uc.execute({ page: 2, limit: 2 });
    const page3 = await uc.execute({ page: 3, limit: 2 });

    // Página 1: los 2 más recientes (u5, u4)
    expect(page1.data.map(d => d.username)).toEqual(['u5', 'u4']);
    // Página 2: los siguientes (u3, u2)
    expect(page2.data.map(d => d.username)).toEqual(['u3', 'u2']);
    // Página 3: el último (u1)
    expect(page3.data.map(d => d.username)).toEqual(['u1']);

    // Verificar que son DISJUNTOS
    const ids1 = new Set(page1.data.map(d => d.id));
    const ids2 = new Set(page2.data.map(d => d.id));
    const ids3 = new Set(page3.data.map(d => d.id));
    const allIds = [...ids1, ...ids2, ...ids3];
    expect(new Set(allIds).size).toBe(allIds.length); // todos únicos

    // Total es 5 en todas las páginas
    expect(page1.total).toBe(5);
    expect(page2.total).toBe(5);
    expect(page3.total).toBe(5);

    // hasNext
    expect(page1.hasNext).toBe(true);
    expect(page2.hasNext).toBe(true);
    expect(page3.hasNext).toBe(false);
  });
});
