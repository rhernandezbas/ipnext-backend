/**
 * ListNe8000PppoeAudit.test.ts — TDD RED → GREEN
 *
 * Use case: ListNe8000PppoeAudit
 * Ports: PppoeServiceRepository + RadiusEventRepository + NasRepository (in-memory)
 * STRICT TDD MODE: RED primero.
 *
 * Cubre:
 * - REQ-DATA-1: solo servicios del NE8000 (nasId match)
 * - REQ-DATA-2: lastStartedAt / lastStoppedAt / currentlyOnline
 * - REQ-FILTER-2: username ILIKE
 * - REQ-FILTER-3: status enabled/disabled
 * - REQ-FILTER-4: enforcedState
 * - REQ-FILTER-5: online (derivado de RadiusEvent)
 * - REQ-PAGE-3: padron vacío válido
 * - REQ-UC-3: NO N+1 (una sola llamada a lastEventByUsername)
 * - REQ-DTO-2: password no aparece en el DTO
 */
import { ListNe8000PppoeAudit, ONLINE_FILTER_MAX_ROWS } from '@application/use-cases/ListNe8000PppoeAudit';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryRadiusEventRepository } from '@infrastructure/adapters/in-memory/InMemoryRadiusEventRepository';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';

const NE8000_IP = '10.75.0.30';

// ── helpers ────────────────────────────────────────────────────────────────────

async function buildFixture() {
  const nasRepo      = new InMemoryNasRepository();
  const pppoeRepo    = new InMemoryPppoeServiceRepository();
  const radiusRepo   = new InMemoryRadiusEventRepository();

  // Crear el NAS NE8000 en el in-memory
  const ne8000 = await nasRepo.createNasServer({
    name:         'NE8000-1',
    type:         'huawei_radius',
    ipAddress:    NE8000_IP,
    radiusSecret: 'secret',
    nasIpAddress: NE8000_IP,
    apiPort:      null,
    apiLogin:     null,
    apiPassword:  null,
    status:       'active',
    lastSeen:     null,
    clientCount:  0,
    description:  'Huawei NE8000-1 BRAS — PPPoE Acceso Sur',
  });

  return { nasRepo, pppoeRepo, radiusRepo, ne8000Id: ne8000.id };
}

async function seedPppoe(
  repo: InMemoryPppoeServiceRepository,
  nasId: string,
  services: Array<{
    username: string;
    status?: string;
    enforcedState?: 'active' | 'reduced' | 'blocked';
    contractId?: string | null;
    remoteAddress?: string | null;
  }>,
) {
  for (const s of services) {
    await repo.upsertByUsername({
      username:      s.username,
      password:      'secret-pw',
      profile:       'Plan-100M',
      remoteAddress: s.remoteAddress ?? null,
      status:        s.status ?? 'enabled',
      nasId,
      contractId:    s.contractId ?? null,
      enforcedState: s.enforcedState ?? 'active',
    });
  }
}

async function seedRadius(
  repo: InMemoryRadiusEventRepository,
  nasId: string,
  events: Array<{
    username: string;
    startedAt: string;
    stoppedAt: string | null;
    status: 'online' | 'closed';
  }>,
) {
  await repo.upsertMany(
    events.map((e, i) => ({
      sourceUniqueId: `uid-ne-${i}`,
      username:       e.username,
      nasIpAddress:   NE8000_IP,
      nasId,
      framedIp:       null,
      macAddress:     null,
      vlanId:         null,
      startedAt:      new Date(e.startedAt),
      stoppedAt:      e.stoppedAt ? new Date(e.stoppedAt) : null,
      sessionTime:    null,
      bytesIn:        BigInt(0),
      bytesOut:       BigInt(0),
      eventType:      e.stoppedAt ? ('stop' as const) : ('start' as const),
      status:         e.status,
    })),
  );
}

// ── suite ───────────────────────────────────────────────────────────────────────

describe('ListNe8000PppoeAudit', () => {
  // ── REQ-DATA-1: solo servicios del NE8000 ──────────────────────────────────
  it('solo incluye servicios del NE8000 (excluye MikroTik)', async () => {
    const { nasRepo, pppoeRepo, radiusRepo, ne8000Id } = await buildFixture();
    await seedPppoe(pppoeRepo, ne8000Id, [{ username: 'ne-user' }]);
    await seedPppoe(pppoeRepo, 'mk-nas-id', [{ username: 'mk-user' }]);

    const uc = new ListNe8000PppoeAudit(pppoeRepo, radiusRepo, nasRepo);
    const result = await uc.execute({});

    expect(result.data).toHaveLength(1);
    expect(result.data[0].username).toBe('ne-user');
  });

  // ── NAS no registrado → devuelve vacío sin romper ─────────────────────────
  it('si no existe el NAS NE8000, devuelve lista vacía sin lanzar error', async () => {
    const nasRepo    = new InMemoryNasRepository(); // sin el NE8000
    const pppoeRepo  = new InMemoryPppoeServiceRepository();
    const radiusRepo = new InMemoryRadiusEventRepository();

    const uc = new ListNe8000PppoeAudit(pppoeRepo, radiusRepo, nasRepo);
    const result = await uc.execute({});

    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  // ── REQ-DATA-2: PPPoE sin historial ───────────────────────────────────────
  it('PPPoE sin historial RADIUS → lastStartedAt=null, lastStoppedAt=null, currentlyOnline=false', async () => {
    const { nasRepo, pppoeRepo, radiusRepo, ne8000Id } = await buildFixture();
    await seedPppoe(pppoeRepo, ne8000Id, [{ username: 'new-user' }]);

    const uc = new ListNe8000PppoeAudit(pppoeRepo, radiusRepo, nasRepo);
    const result = await uc.execute({});

    expect(result.data[0].lastStartedAt).toBeNull();
    expect(result.data[0].lastStoppedAt).toBeNull();
    expect(result.data[0].currentlyOnline).toBe(false);
  });

  // ── REQ-DATA-2: PPPoE con historial, actualmente online ───────────────────
  it('PPPoE online: lastStartedAt=T3, lastStoppedAt=T2, currentlyOnline=true', async () => {
    const { nasRepo, pppoeRepo, radiusRepo, ne8000Id } = await buildFixture();
    await seedPppoe(pppoeRepo, ne8000Id, [{ username: 'c001' }]);
    await seedRadius(radiusRepo, ne8000Id, [
      { username: 'c001', startedAt: '2026-06-01T10:00:00Z', stoppedAt: '2026-06-01T12:00:00Z', status: 'closed' },
      { username: 'c001', startedAt: '2026-06-02T08:00:00Z', stoppedAt: null, status: 'online' },
    ]);

    const uc = new ListNe8000PppoeAudit(pppoeRepo, radiusRepo, nasRepo);
    const result = await uc.execute({});
    const row = result.data[0];

    expect(row.currentlyOnline).toBe(true);
    expect(row.lastStartedAt).toBe('2026-06-02T08:00:00.000Z');
    expect(row.lastStoppedAt).toBe('2026-06-01T12:00:00.000Z');
  });

  // ── REQ-FILTER-2: username substring ─────────────────────────────────────
  it('filtra por username (substring)', async () => {
    const { nasRepo, pppoeRepo, radiusRepo, ne8000Id } = await buildFixture();
    await seedPppoe(pppoeRepo, ne8000Id, [
      { username: 'c001' },
      { username: 'c002' },
      { username: 'other' },
    ]);

    const uc = new ListNe8000PppoeAudit(pppoeRepo, radiusRepo, nasRepo);
    const result = await uc.execute({ username: 'c00' });

    expect(result.total).toBe(2);
    result.data.forEach((r) => expect(r.username).toMatch(/c00/));
  });

  // ── REQ-FILTER-3: status ──────────────────────────────────────────────────
  it('filtra por status=disabled', async () => {
    const { nasRepo, pppoeRepo, radiusRepo, ne8000Id } = await buildFixture();
    await seedPppoe(pppoeRepo, ne8000Id, [
      { username: 'u1', status: 'enabled'  },
      { username: 'u2', status: 'disabled' },
    ]);

    const uc = new ListNe8000PppoeAudit(pppoeRepo, radiusRepo, nasRepo);
    const result = await uc.execute({ status: 'disabled' });

    expect(result.total).toBe(1);
    expect(result.data[0].status).toBe('disabled');
  });

  // ── REQ-FILTER-4: enforcedState ──────────────────────────────────────────
  it('filtra por enforcedState=blocked', async () => {
    const { nasRepo, pppoeRepo, radiusRepo, ne8000Id } = await buildFixture();
    await seedPppoe(pppoeRepo, ne8000Id, [
      { username: 'u1', enforcedState: 'active'  },
      { username: 'u2', enforcedState: 'blocked' },
    ]);

    const uc = new ListNe8000PppoeAudit(pppoeRepo, radiusRepo, nasRepo);
    const result = await uc.execute({ enforcedState: 'blocked' });

    expect(result.total).toBe(1);
    expect(result.data[0].enforcedState).toBe('blocked');
  });

  // ── REQ-FILTER-5: online=true (derivado de RadiusEvent) ──────────────────
  it('filtra online=true: solo los que tienen RadiusEvent activo', async () => {
    const { nasRepo, pppoeRepo, radiusRepo, ne8000Id } = await buildFixture();
    await seedPppoe(pppoeRepo, ne8000Id, [
      { username: 'u-online'  },
      { username: 'u-offline' },
    ]);
    await seedRadius(radiusRepo, ne8000Id, [
      { username: 'u-online', startedAt: '2026-06-01T10:00:00Z', stoppedAt: null, status: 'online' },
    ]);

    const uc = new ListNe8000PppoeAudit(pppoeRepo, radiusRepo, nasRepo);
    const result = await uc.execute({ online: true });

    expect(result.total).toBe(1);
    expect(result.data[0].username).toBe('u-online');
  });

  it('filtra online=false: solo los que NO tienen RadiusEvent activo', async () => {
    const { nasRepo, pppoeRepo, radiusRepo, ne8000Id } = await buildFixture();
    await seedPppoe(pppoeRepo, ne8000Id, [
      { username: 'u-online'  },
      { username: 'u-offline' },
    ]);
    await seedRadius(radiusRepo, ne8000Id, [
      { username: 'u-online', startedAt: '2026-06-01T10:00:00Z', stoppedAt: null, status: 'online' },
    ]);

    const uc = new ListNe8000PppoeAudit(pppoeRepo, radiusRepo, nasRepo);
    const result = await uc.execute({ online: false });

    expect(result.total).toBe(1);
    expect(result.data[0].username).toBe('u-offline');
  });

  // ── REQ-PAGE-3: padron vacío ──────────────────────────────────────────────
  it('padron vacío devuelve estructura correcta', async () => {
    const { nasRepo, pppoeRepo, radiusRepo } = await buildFixture();

    const uc = new ListNe8000PppoeAudit(pppoeRepo, radiusRepo, nasRepo);
    const result = await uc.execute({});

    expect(result).toEqual({
      data:    [],
      total:   0,
      page:    1,
      limit:   50,
      hasNext: false,
    });
  });

  // ── REQ-UC-3: NO N+1 — lastEventByUsername llamado UNA SOLA VEZ ──────────
  it('lastEventByUsername se llama una sola vez (sin N+1)', async () => {
    const { nasRepo, pppoeRepo, radiusRepo, ne8000Id } = await buildFixture();
    await seedPppoe(pppoeRepo, ne8000Id, [
      { username: 'u1' },
      { username: 'u2' },
      { username: 'u3' },
    ]);

    const callCount = { n: 0 };
    const original = radiusRepo.lastEventByUsername.bind(radiusRepo);
    radiusRepo.lastEventByUsername = async (...args) => {
      callCount.n++;
      return original(...args);
    };

    const uc = new ListNe8000PppoeAudit(pppoeRepo, radiusRepo, nasRepo);
    await uc.execute({});

    expect(callCount.n).toBe(1);
  });

  // ── REQ-DTO-2: password NO aparece en el DTO ─────────────────────────────
  it('password no aparece en el DTO', async () => {
    const { nasRepo, pppoeRepo, radiusRepo, ne8000Id } = await buildFixture();
    await seedPppoe(pppoeRepo, ne8000Id, [{ username: 'c001' }]);

    const uc = new ListNe8000PppoeAudit(pppoeRepo, radiusRepo, nasRepo);
    const result = await uc.execute({});
    const row = result.data[0];

    expect('password' in row).toBe(false);
  });

  // ── REQ-UC-2: orden default username ASC ─────────────────────────────────
  it('ordena por username ASC por defecto', async () => {
    const { nasRepo, pppoeRepo, radiusRepo, ne8000Id } = await buildFixture();
    await seedPppoe(pppoeRepo, ne8000Id, [
      { username: 'z-user' },
      { username: 'a-user' },
    ]);

    const uc = new ListNe8000PppoeAudit(pppoeRepo, radiusRepo, nasRepo);
    const result = await uc.execute({});

    expect(result.data[0].username).toBe('a-user');
    expect(result.data[1].username).toBe('z-user');
  });

  // ── Paginación ─────────────────────────────────────────────────────────────
  it('pagina correctamente', async () => {
    const { nasRepo, pppoeRepo, radiusRepo, ne8000Id } = await buildFixture();
    await seedPppoe(pppoeRepo, ne8000Id, Array.from({ length: 5 }, (_, i) => ({ username: `u${i}` })));

    const uc = new ListNe8000PppoeAudit(pppoeRepo, radiusRepo, nasRepo);
    const page1 = await uc.execute({ page: 1, limit: 2 });
    const page2 = await uc.execute({ page: 2, limit: 2 });

    expect(page1.data).toHaveLength(2);
    expect(page1.hasNext).toBe(true);
    expect(page2.data).toHaveLength(2);
    expect(page1.total).toBe(5);
  });

  // ── FIX 8: NE8000 IP inyectable (no hardcodeada en application layer) ───────

  it('FIX8: IP del NE8000 inyectable — usar IP diferente al default y encontrar el NAS', async () => {
    // Crear NAS con IP diferente al default '10.75.0.30'
    const nasRepo    = new InMemoryNasRepository();
    const pppoeRepo  = new InMemoryPppoeServiceRepository();
    const radiusRepo = new InMemoryRadiusEventRepository();

    const customIp = '10.99.0.1';
    const ne8000Custom = await nasRepo.createNasServer({
      name:         'NE8000-custom',
      type:         'huawei_radius',
      ipAddress:    customIp,
      radiusSecret: 'secret',
      nasIpAddress: customIp,
      apiPort:      null, apiLogin: null, apiPassword: null,
      status:       'active', lastSeen: null, clientCount: 0, description: 'custom',
    });
    await seedPppoe(pppoeRepo, ne8000Custom.id, [{ username: 'custom-user' }]);

    // Con la IP inyectada, debe encontrar el NAS y el usuario
    const uc = new ListNe8000PppoeAudit(pppoeRepo, radiusRepo, nasRepo, customIp);
    const result = await uc.execute({});

    expect(result.data).toHaveLength(1);
    expect(result.data[0].username).toBe('custom-user');
  });

  it('FIX8: sin IP inyectada → usa default 10.75.0.30', async () => {
    // Sin el 4to arg, el comportamiento existente debe preservarse (default IP)
    const { nasRepo, pppoeRepo, radiusRepo, ne8000Id } = await buildFixture();
    await seedPppoe(pppoeRepo, ne8000Id, [{ username: 'default-user' }]);

    const uc = new ListNe8000PppoeAudit(pppoeRepo, radiusRepo, nasRepo); // sin 4to arg
    const result = await uc.execute({});

    expect(result.data).toHaveLength(1);
    expect(result.data[0].username).toBe('default-user');
  });

  // ── FIX 9: ONLINE_FILTER_MAX_ROWS constante (no magic number 99999) ────────

  it('FIX9: ONLINE_FILTER_MAX_ROWS es una constante exportada (no magic number)', () => {
    // La constante debe estar exportada para que infra pueda documentarla en logs.
    // Antes: 99999 hardcodeado dentro de executeWithOnlineFilter.
    expect(ONLINE_FILTER_MAX_ROWS).toBeDefined();
    expect(typeof ONLINE_FILTER_MAX_ROWS).toBe('number');
    expect(ONLINE_FILTER_MAX_ROWS).toBeGreaterThan(0);
  });

  it('FIX9: con filtro online sin truncado → hasNext refleja paginación real', async () => {
    const { nasRepo, pppoeRepo, radiusRepo, ne8000Id } = await buildFixture();
    await seedPppoe(pppoeRepo, ne8000Id, [
      { username: 'online-1' },
      { username: 'online-2' },
      { username: 'offline-1' },
    ]);
    await radiusRepo.upsertMany([
      { sourceUniqueId: 'ev-1', username: 'online-1', nasIpAddress: NE8000_IP, nasId: ne8000Id,
        framedIp: null, macAddress: null, vlanId: null, startedAt: new Date('2026-06-22T10:00:00Z'),
        stoppedAt: null, sessionTime: null, bytesIn: BigInt(0), bytesOut: BigInt(0),
        eventType: 'start' as const, status: 'online' as const },
    ]);

    const uc = new ListNe8000PppoeAudit(pppoeRepo, radiusRepo, nasRepo);
    // Filtro online=true: solo 'online-1' coincide
    const result = await uc.execute({ online: true, limit: 10 });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].username).toBe('online-1');
    expect(result.hasNext).toBe(false); // no hay más
    expect(result.total).toBe(1);
  });
});
