/**
 * AutoMovePppoe use case — TDD tests (pppoe-move-nas W2, design D4 + D-W2.1..D-W2.4).
 *
 * Matriz spec.md:
 *   S4.1 sesión de userX en NAS B con servicio asignado al NAS A → mismatch detectado y movido
 *   S4.2 sesión con nasIpAddress que no mapea a ningún NasServer → skipped_unknown_nas, NO move
 *   S4.3 NAS real == asignado → cero acciones
 *   S5.1 mismatch con IP actual cgnat → auto-move ejecutado hacia el NAS real (SIN force)
 *   S5.2 mismatch con IP en pool public → skipped_public (reason public_pool), cero move
 *   S5.3 mismatch con IP fuera de todo pool → skipped_public (reason unclassified_ip), cero move
 *   S6.1 dos mismatches, el 1º falla (pool lleno) → el 2º se mueve igual; resumen 1 moved / 1 failed
 *   S8.2 auto-move con contrato → evento historial 'modified' con actor 'sistema'
 *   S10.5 throttle anti-spam: mismo skip/fallo (<6h, mismo outcome+toNasId) → UNA fila
 *         (el intento/skip igual OCURRE cada tick; solo se throttlea el registro); >6h → nueva fila
 *   multi-sesión: mismo NAS → la más reciente gana (un solo move) · NAS distintos entre sí → skip del tick
 *   sesión sin PppoeService espejado → ignorada con contador (sin fila)
 *   paginación del GET /sessions: >PAGE_SIZE sesiones → se recorren todas
 */
import { AutoMovePppoe } from '@application/use-cases/AutoMovePppoe';
import { MovePppoeToNas } from '@application/use-cases/MovePppoeToNas';
import { MovePppoeServiceToRouter } from '@application/use-cases/MovePppoeServiceToRouter';
import { FindFreeIp } from '@application/use-cases/FindFreeIp';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { InMemoryRouterGateway } from '@infrastructure/adapters/in-memory/InMemoryRouterGateway';
import { InMemoryIpNetworkRepository } from '@infrastructure/adapters/in-memory/InMemoryIpNetworkRepository';
import { InMemoryPppoeNasMoveEventRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeNasMoveEventRepository';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import type { NasServer } from '@domain/entities/nas';
import type { OrchestratorSession } from '@domain/ports/RadiusOrchestratorGateway';

const NAS_A    = '3';        // seed InMemoryNasRepository: radius_orchestrator
const NAS_A_IP = '10.0.0.5'; // nasIpAddress del NAS A (seed)
const NAS_B_IP = '10.0.0.6';
const NAS_C_IP = '10.0.0.7';

const OLD_IP  = '100.64.60.25'; // en pool-a (cgnat del NAS A)
const OLD_IP2 = '100.64.60.26';

function session(username: string, nasIp: string, startedAt = '2026-07-02T10:00:00Z'): OrchestratorSession {
  return {
    sessionId: `${username}@${nasIp}@${startedAt}`,
    username,
    nasIp,
    framedIp: null,
    startedAt,
    bytesIn: 0,
    bytesOut: 0,
    callerId: null,
  };
}

interface Fixture {
  pppoeRepo: InMemoryPppoeServiceRepository;
  nasRepo: InMemoryNasRepository;
  orchestrator: InMemoryRadiusOrchestratorGateway;
  netRepo: InMemoryIpNetworkRepository;
  moveEvents: InMemoryPppoeNasMoveEventRepository;
  eventRepo: InMemoryContractServiceEventRepository;
  catalogRepo: InMemoryServiceCatalogRepository;
  nasB: NasServer;
  nasC: NasServer;
  uc: AutoMovePppoe;
}

async function buildFixture(opts?: {
  globalSessions?: OrchestratorSession[];
  /** IPs ya asignadas en el RADIUS. Default: .43.2 tomada (primera libre de B = .43.3) y pool C LLENO. */
  assignedIps?: string[];
  /** Repo de eventos custom (p.ej. con clock inyectado para el test de expiración del throttle). */
  moveEvents?: InMemoryPppoeNasMoveEventRepository;
  /** Clock del watcher (para el chequeo de throttle). Default: Date.now real. */
  now?: () => Date;
}): Promise<Fixture> {
  const pppoeRepo  = new InMemoryPppoeServiceRepository();
  const nasRepo    = new InMemoryNasRepository();
  const routerGw   = new InMemoryRouterGateway();
  const netRepo    = new InMemoryIpNetworkRepository();
  const moveEvents = opts?.moveEvents ?? new InMemoryPppoeNasMoveEventRepository();
  const eventRepo  = new InMemoryContractServiceEventRepository();
  const catalogRepo = new InMemoryServiceCatalogRepository();
  await catalogRepo.create({ name: 'INTERNET' });

  const orchestrator = new InMemoryRadiusOrchestratorGateway({
    assignedIps: opts?.assignedIps ?? ['100.64.43.2', '100.64.44.2', OLD_IP],
    globalSessions: opts?.globalSessions ?? [],
  });

  // NAS B radius (nasIp 10.0.0.6) con pool cgnat 100.64.43.0/24 — destino "sano".
  const nasB = await nasRepo.createNasServer({
    name: 'NAS Radius B',
    type: 'radius_orchestrator',
    ipAddress: NAS_B_IP,
    radiusSecret: 'x',
    nasIpAddress: NAS_B_IP,
    apiPort: null,
    apiLogin: null,
    apiPassword: null,
    status: 'active',
    lastSeen: null,
    clientCount: 0,
    description: 'destino radius',
  });
  netRepo.seedNetwork({
    id: 'net-b', network: '100.64.43.0/24', gateway: '100.64.43.1', dns1: '8.8.8.8', dns2: '8.8.4.4',
    description: 'CGNAT NAS B', partnerId: null, type: 'pppoe', totalIps: 254, usedIps: null, freeIps: null,
  });
  netRepo.seedPool({
    id: 'pool-b', name: 'cgnat-nas-b', networkId: 'net-b',
    rangeStart: '100.64.43.2', rangeEnd: '100.64.43.254',
    type: 'static', assignedCount: null, totalCount: 253, nasId: nasB.id, ipKind: 'cgnat',
  });

  // NAS C radius (nasIp 10.0.0.7) con pool cgnat de UNA sola IP ya tomada → pool LLENO (S6.1).
  const nasC = await nasRepo.createNasServer({
    name: 'NAS Radius C (pool lleno)',
    type: 'radius_orchestrator',
    ipAddress: NAS_C_IP,
    radiusSecret: 'x',
    nasIpAddress: NAS_C_IP,
    apiPort: null,
    apiLogin: null,
    apiPassword: null,
    status: 'active',
    lastSeen: null,
    clientCount: 0,
    description: 'destino radius pool lleno',
  });
  netRepo.seedNetwork({
    id: 'net-c', network: '100.64.44.0/24', gateway: '100.64.44.1', dns1: '8.8.8.8', dns2: '8.8.4.4',
    description: 'CGNAT NAS C', partnerId: null, type: 'pppoe', totalIps: 254, usedIps: null, freeIps: null,
  });
  netRepo.seedPool({
    id: 'pool-c', name: 'cgnat-nas-c', networkId: 'net-c',
    rangeStart: '100.64.44.2', rangeEnd: '100.64.44.2',
    type: 'static', assignedCount: null, totalCount: 1, nasId: nasC.id, ipKind: 'cgnat',
  });

  // Pool PUBLIC cargado (clasifica la IP actual — S5.2) + pool cgnat del NAS A origen (cubre OLD_IP).
  netRepo.seedNetwork({
    id: 'net-pub', network: '190.15.242.0/24', gateway: '190.15.242.1', dns1: '8.8.8.8', dns2: '8.8.4.4',
    description: 'Públicas corporativas', partnerId: null, type: 'pppoe', totalIps: 254, usedIps: null, freeIps: null,
  });
  netRepo.seedPool({
    id: 'pool-pub', name: 'publicas', networkId: 'net-pub',
    rangeStart: '190.15.242.2', rangeEnd: '190.15.242.254',
    type: 'static', assignedCount: null, totalCount: 253, nasId: null, ipKind: 'public',
  });
  netRepo.seedNetwork({
    id: 'net-a', network: '100.64.60.0/24', gateway: '100.64.60.1', dns1: '8.8.8.8', dns2: '8.8.4.4',
    description: 'CGNAT NAS A (origen)', partnerId: null, type: 'pppoe', totalIps: 254, usedIps: null, freeIps: null,
  });
  netRepo.seedPool({
    id: 'pool-a', name: 'cgnat-nas-a', networkId: 'net-a',
    rangeStart: '100.64.60.2', rangeEnd: '100.64.60.254',
    type: 'static', assignedCount: null, totalCount: 253, nasId: NAS_A, ipKind: 'cgnat',
  });

  const findFreeIp = new FindFreeIp(netRepo, nasRepo, routerGw, orchestrator);
  const legacyMove = new MovePppoeServiceToRouter(pppoeRepo, routerGw, nasRepo);
  const move = new MovePppoeToNas(
    pppoeRepo, nasRepo, orchestrator, findFreeIp, legacyMove, moveEvents, catalogRepo, eventRepo, netRepo,
  );
  const uc = new AutoMovePppoe(
    orchestrator, nasRepo, pppoeRepo, netRepo, moveEvents, move,
    opts?.now ? { now: opts.now } : undefined,
  );

  return { pppoeRepo, nasRepo, orchestrator, netRepo, moveEvents, eventRepo, catalogRepo, nasB, nasC, uc };
}

async function seedService(
  fx: Fixture,
  overrides: Partial<Parameters<InMemoryPppoeServiceRepository['upsertByUsername']>[0]> = {},
) {
  return fx.pppoeRepo.upsertByUsername({
    username: 'user1',
    password: 'secret',
    profile: 'IP-Air-10M',
    remoteAddress: OLD_IP,
    status: 'enabled',
    nasId: NAS_A,
    contractId: null,
    ipMode: 'fixed',
    ...overrides,
  });
}

const ZERO = {
  sessions: 0, mismatches: 0, moved: 0, skippedPublic: 0,
  skippedUnknownNas: 0, failed: 0, throttled: 0, ignoredNoService: 0,
};

describe('AutoMovePppoe — detección de mismatch (REQ-AUTO-1)', () => {
  it('S4.1/S5.1: sesión en NAS B con servicio en NAS A e IP cgnat → move ejecutado hacia el NAS real', async () => {
    const fx = await buildFixture({ globalSessions: [session('user1', NAS_B_IP)] });
    const s = await seedService(fx);

    const summary = await fx.uc.run();

    expect(summary).toEqual({ ...ZERO, sessions: 1, mismatches: 1, moved: 1 });

    // El servicio quedó en el NAS REAL (B) con IP nueva del pool cgnat de B, fija.
    const row = await fx.pppoeRepo.findById(s.id);
    expect(row!.nasId).toBe(fx.nasB.id);
    expect(row!.remoteAddress).toBe('100.64.43.3'); // .2 tomada → primera libre
    expect(row!.ipMode).toBe('fixed');

    // El RADIUS recibió la Framed-IP nueva (el move real de W1 corrió, sin force).
    const call = fx.orchestrator.calls.find(c => c.op === 'changeFramedIp' && c.username === 'user1');
    expect(call).toBeDefined();
    expect((call!.arg as { framedIp: string }).framedIp).toBe('100.64.43.3');

    // Registro visible: moved con trigger auto y actor sistema (REQ-LOG-1).
    const events = fx.moveEvents.all();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      username: 'user1',
      fromNasId: NAS_A,
      toNasId: fx.nasB.id,
      fromIp: OLD_IP,
      toIp: '100.64.43.3',
      trigger: 'auto',
      outcome: 'moved',
      actorName: 'sistema',
    });
  });

  it('S4.3: NAS real == asignado → cero acciones (ni RADIUS ni filas)', async () => {
    const fx = await buildFixture({ globalSessions: [session('user1', NAS_A_IP)] });
    const s = await seedService(fx);

    const summary = await fx.uc.run();

    expect(summary).toEqual({ ...ZERO, sessions: 1 });
    expect(fx.orchestrator.calls).toHaveLength(0);
    expect(fx.moveEvents.all()).toHaveLength(0);
    const row = await fx.pppoeRepo.findById(s.id);
    expect(row!.nasId).toBe(NAS_A);
    expect(row!.remoteAddress).toBe(OLD_IP);
  });

  it('S4.2: nasIpAddress desconocida → skipped_unknown_nas + NO move', async () => {
    const fx = await buildFixture({ globalSessions: [session('user1', '10.99.99.99')] });
    const s = await seedService(fx);

    const summary = await fx.uc.run();

    expect(summary).toEqual({ ...ZERO, sessions: 1, skippedUnknownNas: 1 });
    expect(fx.orchestrator.calls).toHaveLength(0);
    const row = await fx.pppoeRepo.findById(s.id);
    expect(row!.nasId).toBe(NAS_A);

    // Fila VISIBLE (REQ-LOG-1): el NAS fantasma no puede vivir solo en el stdout.
    const events = fx.moveEvents.all();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      username: 'user1',
      fromNasId: NAS_A,
      toNasId: null,
      trigger: 'auto',
      outcome: 'skipped_unknown_nas',
      actorName: 'sistema',
    });
  });

  it('sesión sin PppoeService espejado → ignorada con contador, sin fila', async () => {
    const fx = await buildFixture({ globalSessions: [session('ghost', NAS_B_IP)] });

    const summary = await fx.uc.run();

    expect(summary).toEqual({ ...ZERO, sessions: 1, ignoredNoService: 1 });
    expect(fx.moveEvents.all()).toHaveLength(0);
    expect(fx.orchestrator.calls).toHaveLength(0);
  });
});

describe('AutoMovePppoe — pre-clasificación CGNAT/public (REQ-AUTO-2, D-W2.1)', () => {
  it('S5.2: IP actual en pool public → skipped_public (reason public_pool), CERO move', async () => {
    const fx = await buildFixture({ globalSessions: [session('user1', NAS_B_IP)] });
    const s = await seedService(fx, { remoteAddress: '190.15.242.10' });

    const summary = await fx.uc.run();

    expect(summary).toEqual({ ...ZERO, sessions: 1, mismatches: 1, skippedPublic: 1 });
    // El move de W1 NUNCA se llamó (pre-clasificación, no dependemos del guard 409 del core).
    expect(fx.orchestrator.calls.filter(c => c.op === 'changeFramedIp')).toHaveLength(0);
    const row = await fx.pppoeRepo.findById(s.id);
    expect(row!.nasId).toBe(NAS_A);
    expect(row!.remoteAddress).toBe('190.15.242.10');

    const events = fx.moveEvents.all();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      username: 'user1',
      fromNasId: NAS_A,
      toNasId: fx.nasB.id,
      fromIp: '190.15.242.10',
      trigger: 'auto',
      outcome: 'skipped_public',
      reason: 'public_pool',
      actorName: 'sistema',
    });
  });

  it('S5.3: IP actual fuera de TODO pool cargado → skipped_public (reason unclassified_ip), CERO move', async () => {
    const fx = await buildFixture({ globalSessions: [session('user1', NAS_B_IP)] });
    const s = await seedService(fx, { remoteAddress: '203.0.113.50' });

    const summary = await fx.uc.run();

    expect(summary).toEqual({ ...ZERO, sessions: 1, mismatches: 1, skippedPublic: 1 });
    expect(fx.orchestrator.calls.filter(c => c.op === 'changeFramedIp')).toHaveLength(0);
    const row = await fx.pppoeRepo.findById(s.id);
    expect(row!.remoteAddress).toBe('203.0.113.50');

    const events = fx.moveEvents.all();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: 'skipped_public', reason: 'unclassified_ip' });
  });
});

describe('AutoMovePppoe — aislamiento por ítem (REQ-AUTO-3)', () => {
  it('S6.1: dos mismatches, el 1º falla con pool LLENO → el 2º se mueve igual; resumen 1 moved / 1 failed', async () => {
    const fx = await buildFixture({
      globalSessions: [
        session('user1', NAS_C_IP), // destino C: pool cgnat LLENO → NoFreeIpError
        session('user2', NAS_B_IP), // destino B: pool con lugar → move OK
      ],
    });
    const s1 = await seedService(fx);
    const s2 = await seedService(fx, { username: 'user2', remoteAddress: OLD_IP2 });

    const summary = await fx.uc.run();

    expect(summary).toEqual({ ...ZERO, sessions: 2, mismatches: 2, moved: 1, failed: 1 });

    // user1 quedó como estaba (nada cambió — S1.3 del core).
    const row1 = await fx.pppoeRepo.findById(s1.id);
    expect(row1!.nasId).toBe(NAS_A);
    expect(row1!.remoteAddress).toBe(OLD_IP);
    // user2 se movió igual (el fallo del 1º NO abortó el tick).
    const row2 = await fx.pppoeRepo.findById(s2.id);
    expect(row2!.nasId).toBe(fx.nasB.id);
    expect(row2!.remoteAddress).toBe('100.64.43.3');

    // Registro visible de AMBOS resultados: el failed lo registra el CORE de W1 (S10.2).
    const outcomes = fx.moveEvents.all().map(e => ({ username: e.username, outcome: e.outcome }));
    expect(outcomes).toContainEqual({ username: 'user1', outcome: 'failed_no_free_ip' });
    expect(outcomes).toContainEqual({ username: 'user2', outcome: 'moved' });
    expect(fx.moveEvents.all()).toHaveLength(2);
  });
});

describe('AutoMovePppoe — multi-sesión por username (D-W2.4)', () => {
  it('dos sesiones vivas en el MISMO NAS → se procesa una vez (la más reciente gana), un solo move', async () => {
    const fx = await buildFixture({
      globalSessions: [
        session('user1', NAS_B_IP, '2026-07-02T09:00:00Z'),
        session('user1', NAS_B_IP, '2026-07-02T10:00:00Z'),
      ],
    });
    await seedService(fx);

    const summary = await fx.uc.run();

    expect(summary).toEqual({ ...ZERO, sessions: 2, mismatches: 1, moved: 1 });
    expect(fx.orchestrator.calls.filter(c => c.op === 'changeFramedIp')).toHaveLength(1);
    expect(fx.moveEvents.all().map(e => e.outcome)).toEqual(['moved']);
  });

  it('sesiones vivas en NAS DISTINTOS entre sí (transitorio de re-auth) → saltear el tick, cero acciones', async () => {
    const fx = await buildFixture({
      globalSessions: [
        session('user1', NAS_A_IP, '2026-07-02T09:00:00Z'),
        session('user1', NAS_B_IP, '2026-07-02T10:00:00Z'),
      ],
    });
    const s = await seedService(fx);

    const summary = await fx.uc.run();

    expect(summary).toEqual({ ...ZERO, sessions: 2 });
    expect(fx.orchestrator.calls).toHaveLength(0);
    expect(fx.moveEvents.all()).toHaveLength(0);
    const row = await fx.pppoeRepo.findById(s.id);
    expect(row!.nasId).toBe(NAS_A);
  });
});

describe('AutoMovePppoe — historial del contrato (REQ-HIST-1)', () => {
  it("S8.2: auto-move con contrato → evento 'modified' con actor 'sistema' y trigger auto", async () => {
    const fx = await buildFixture({ globalSessions: [session('user1', NAS_B_IP)] });
    await seedService(fx, { contractId: 'c-9' });

    await fx.uc.run();

    const events = fx.eventRepo.all();
    expect(events).toHaveLength(1);
    expect(events[0].contractId).toBe('c-9');
    expect(events[0].eventType).toBe('modified');
    expect(events[0].actorName).toBe('sistema');
    expect(events[0].notes).toContain('[auto]');
  });
});

describe('AutoMovePppoe — throttle anti-spam de filas (S10.5, D-W2.2)', () => {
  it('dos ticks seguidos con el MISMO skipped_public → UNA fila; el 2º tick reporta throttled=1', async () => {
    const fx = await buildFixture({ globalSessions: [session('user1', NAS_B_IP)] });
    await seedService(fx, { remoteAddress: '190.15.242.10' });

    const first = await fx.uc.run();
    const second = await fx.uc.run();

    // El SKIP ocurre en ambos ticks; la FILA solo se registra una vez.
    expect(first).toEqual({ ...ZERO, sessions: 1, mismatches: 1, skippedPublic: 1 });
    expect(second).toEqual({ ...ZERO, sessions: 1, mismatches: 1, skippedPublic: 1, throttled: 1 });
    expect(fx.moveEvents.all().filter(e => e.outcome === 'skipped_public')).toHaveLength(1);
  });

  it('dos ticks seguidos con el MISMO failed_no_free_ip → el move SÍ se reintenta, pero UNA sola fila (throttle en el core, trigger auto)', async () => {
    const fx = await buildFixture({ globalSessions: [session('user1', NAS_C_IP)] });
    await seedService(fx);

    const first = await fx.uc.run();
    const second = await fx.uc.run();

    // El intento se repite cada tick (barato) — el resumen es honesto en ambos.
    expect(first.failed).toBe(1);
    expect(second.failed).toBe(1);
    // …pero el registro visible NO spamea: una sola fila failed_no_free_ip.
    expect(fx.moveEvents.all().filter(e => e.outcome === 'failed_no_free_ip')).toHaveLength(1);
    // La supresión del core no es visible para el watcher: throttled solo cuenta skips propios.
    expect(second.throttled).toBe(0);
  });

  it('mismo skip pero el último evento tiene MÁS de 6h → registra fila nueva (el throttle expira)', async () => {
    let clock = new Date('2026-07-02T00:00:00Z');
    const moveEvents = new InMemoryPppoeNasMoveEventRepository({ now: () => clock });
    const fx = await buildFixture({
      globalSessions: [session('user1', NAS_B_IP)],
      moveEvents,
      now: () => clock,
    });
    await seedService(fx, { remoteAddress: '190.15.242.10' });

    await fx.uc.run(); // fila 1 @ 00:00
    clock = new Date('2026-07-02T07:00:00Z'); // +7h > ventana de 6h
    const second = await fx.uc.run();

    expect(second.throttled).toBe(0);
    expect(second.skippedPublic).toBe(1);
    expect(fx.moveEvents.all().filter(e => e.outcome === 'skipped_public')).toHaveLength(2);
  });

  it("los 'moved' SIEMPRE se registran (cambian estado, no se throttlean)", async () => {
    const fx = await buildFixture({ globalSessions: [session('user1', NAS_B_IP)] });
    await seedService(fx);

    const summary = await fx.uc.run();

    expect(summary.moved).toBe(1);
    expect(fx.moveEvents.all().map(e => e.outcome)).toEqual(['moved']);
  });
});

describe('AutoMovePppoe — paginación del GET /sessions', () => {
  it('más sesiones que una página del orchestrator → se recorren TODAS', async () => {
    // 501 sesiones (> PAGE_SIZE 500) de usernames sin espejo → el resumen prueba que se
    // paginó más allá de la primera página sin acciones colaterales.
    const globalSessions = Array.from({ length: 501 }, (_, i) => session(`ghost${i}`, NAS_B_IP));
    const fx = await buildFixture({ globalSessions });

    const summary = await fx.uc.run();

    expect(summary.sessions).toBe(501);
    expect(summary.ignoredNoService).toBe(501);
    expect(fx.moveEvents.all()).toHaveLength(0);
  });
});
