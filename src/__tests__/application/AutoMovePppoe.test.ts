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
 *
 * D-W2.5 (endurecimiento post-review W2 — 2 revisores adversariales):
 *   C3  circuit breaker: mismatches > AUTO_MOVE_ABORT_THRESHOLD (25) → tick ABORTADO, cero moves/filas
 *   C3  cap: a lo sumo AUTO_MOVE_MAX_MOVES_PER_TICK (10) moves por tick, el resto `deferred`
 *   C2a cooldown anti-revert: último 'moved' (cualquier trigger) < 10 min → skippedCooldown, sin move
 *   C2b re-verificación pre-execute: re-fetch servicio (ya en target → alreadyConverged) +
 *       re-fetch listSessions (ganador fresco ya no apunta al target → skip)
 *   C1  freshness: sesión ganadora sin actividad < 72h (startedAt — el wire de /sessions NO trae
 *       lastUpdate) → skipped_stale_session (fila, throttled), cero move
 *   W7  conflicto multi-NAS → skipped_nas_conflict (fila, throttled) en vez de WARN invisible
 *   W4  terminated pre-filter: sin fila, sin core call, sin failed++
 *   W5/W6/S9 throttle v2: match EXACTO de username (perez1 vs perez10), solo suprime si el último
 *       es trigger 'auto', compara también reason, error del check → FAIL-OPEN
 *   S10 summary honesto: moved++ solo con move real; +aborted/deferred/skippedCooldown/
 *       alreadyConverged/skippedTerminated/skippedStale/nasConflicts
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

/**
 * Reloj FIJO del fixture (determinismo): las sesiones default (10:00Z) quedan FRESCAS (2h) para
 * el freshness gate de 72h aunque la suite corra meses después — fechas absolutas en las sesiones
 * + reloj REAL serían tests que expiran solos. El mismo reloj alimenta al watcher Y al repo de
 * eventos (cooldown/throttle comparan createdAt de las filas contra el now del watcher).
 */
const FIXED_NOW = new Date('2026-07-02T12:00:00Z');

async function buildFixture(opts?: {
  globalSessions?: OrchestratorSession[];
  /** IPs ya asignadas en el RADIUS. Default: .43.2 tomada (primera libre de B = .43.3) y pool C LLENO. */
  assignedIps?: string[];
  /** Repo de eventos custom (p.ej. con clock inyectado para el test de expiración del throttle). */
  moveEvents?: InMemoryPppoeNasMoveEventRepository;
  /** Clock compartido watcher+eventos. Default: FIXED_NOW. */
  now?: () => Date;
  /**
   * D-W2.5 C2b: override del GET /users/{u}/sessions (re-verificación pre-execute). Default:
   * las mismas sesiones de globalSessions agrupadas por username (como el orchestrator real,
   * donde /sessions y /users/{u}/sessions leen el mismo radacct).
   */
  perUserSessions?: Record<string, OrchestratorSession[]>;
}): Promise<Fixture> {
  const now = opts?.now ?? (() => FIXED_NOW);
  const pppoeRepo  = new InMemoryPppoeServiceRepository();
  const nasRepo    = new InMemoryNasRepository();
  const routerGw   = new InMemoryRouterGateway();
  const netRepo    = new InMemoryIpNetworkRepository();
  const moveEvents = opts?.moveEvents ?? new InMemoryPppoeNasMoveEventRepository({ now });
  const eventRepo  = new InMemoryContractServiceEventRepository();
  const catalogRepo = new InMemoryServiceCatalogRepository();
  await catalogRepo.create({ name: 'INTERNET' });

  const globalSessions = opts?.globalSessions ?? [];
  const perUser = new Map<string, OrchestratorSession[]>();
  for (const s of globalSessions) {
    const list = perUser.get(s.username);
    if (list) list.push(s);
    else perUser.set(s.username, [s]);
  }
  for (const [u, ss] of Object.entries(opts?.perUserSessions ?? {})) perUser.set(u, ss);

  const orchestrator = new InMemoryRadiusOrchestratorGateway({
    assignedIps: opts?.assignedIps ?? ['100.64.43.2', '100.64.44.2', OLD_IP],
    globalSessions,
    seed: [...perUser.entries()].map(([username, sessions]) => ({ username, sessions })),
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
  // pppoe-preprovision (fix colateral): el reloj FIJO también va al CORE — su throttle de
  // registro comparaba el createdAt congelado del repo contra Date.now() REAL, y la ventana
  // de 6h "expiraba" según la hora de la corrida (fila duplicada → test time-bomb).
  const move = new MovePppoeToNas(
    pppoeRepo, nasRepo, orchestrator, findFreeIp, legacyMove, moveEvents, catalogRepo, eventRepo, netRepo, now,
  );
  const uc = new AutoMovePppoe(
    orchestrator, nasRepo, pppoeRepo, netRepo, moveEvents, move,
    { now },
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
  // D-W2.5: summary honesto — breaker/cap/cooldown/re-verify/terminated/freshness/conflicto.
  aborted: false, deferred: 0, skippedCooldown: 0, alreadyConverged: 0,
  skippedTerminated: 0, skippedStale: 0, nasConflicts: 0,
  // pppoe-preprovision D6 (campos ADITIVOS, siempre 0 en esta suite — acá no hay pendientes
  // y ningún escenario tiene presión de cap con fallo reciente): adopciones contadas aparte
  // del breaker + anti-starvation del cap. Los asserts de W2 NO cambian.
  adoptions: 0, skippedRecentFailure: 0,
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

  // D-W2.5 item 5 (W7): el skip por multi-NAS era WARN invisible en stdout — ahora es una fila
  // `skipped_nas_conflict` (throttled). Es el estado TERMINAL del C1 (stale colgada en un NAS +
  // sesión real en otro): tiene que verse en el tab. Test actualizado del contrato W2 original
  // (que esperaba cero filas).
  it('sesiones vivas en NAS DISTINTOS entre sí → fila skipped_nas_conflict (throttled) + CERO move', async () => {
    const fx = await buildFixture({
      globalSessions: [
        session('user1', NAS_A_IP, '2026-07-02T09:00:00Z'),
        session('user1', NAS_B_IP, '2026-07-02T10:00:00Z'),
      ],
    });
    const s = await seedService(fx);

    const first = await fx.uc.run();
    const second = await fx.uc.run();

    expect(first).toEqual({ ...ZERO, sessions: 2, nasConflicts: 1 });
    // 2º tick: el conflicto persiste pero la fila se suprime (throttle 6h).
    expect(second).toEqual({ ...ZERO, sessions: 2, nasConflicts: 1, throttled: 1 });
    expect(fx.orchestrator.calls).toHaveLength(0);

    const rows = fx.moveEvents.all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      username: 'user1',
      fromNasId: NAS_A,
      toNasId: null, // no hay UN target: hay sesiones en varios NAS
      trigger: 'auto',
      outcome: 'skipped_nas_conflict',
      reason: `sessions_on_multiple_nas:${NAS_A_IP},${NAS_B_IP}`,
      actorName: 'sistema',
    });
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

// ════════════════════════════════════════════════════════════════════════════════════════════
// D-W2.5 — Endurecimiento post-review W2 (2 revisores adversariales: 3 CRITICAL + 8 W/S)
// ════════════════════════════════════════════════════════════════════════════════════════════

describe('AutoMovePppoe — circuit breaker + cap (D-W2.5 item 1, C3)', () => {
  it('26 mismatches (> AUTO_MOVE_ABORT_THRESHOLD default 25) → tick ABORTADO: aborted=true, CERO moves, CERO filas', async () => {
    // C3: un NAS duplicado en el inventario (o nasIpAddress mal editada) convierte a TODO el
    // padrón en "mismatch" — sin breaker eso son cientos de kicks automáticos en UN tick.
    const users = Array.from({ length: 26 }, (_, i) => `bulk${i}`);
    const fx = await buildFixture({ globalSessions: users.map(u => session(u, NAS_B_IP)) });
    for (const u of users) await seedService(fx, { username: u });

    const summary = await fx.uc.run();

    expect(summary).toEqual({ ...ZERO, sessions: 26, mismatches: 26, aborted: true });
    expect(fx.orchestrator.calls).toHaveLength(0);   // ni changeFramedIp ni kicks
    expect(fx.moveEvents.all()).toHaveLength(0);     // el tick entero se aborta: tampoco filas
    const rows = await fx.pppoeRepo.findByUsernames(users);
    expect(rows.every(r => r.nasId === NAS_A)).toBe(true); // nadie se movió
  });

  it('15 mismatches con cap default 10 → 10 moves + deferred=5 (el resto queda para el próximo tick)', async () => {
    const users = Array.from({ length: 15 }, (_, i) => `cap${i}`);
    const fx = await buildFixture({ globalSessions: users.map(u => session(u, NAS_B_IP)) });
    for (const u of users) await seedService(fx, { username: u });

    const summary = await fx.uc.run();

    expect(summary).toEqual({ ...ZERO, sessions: 15, mismatches: 15, moved: 10, deferred: 5 });
    expect(fx.moveEvents.all().filter(e => e.outcome === 'moved')).toHaveLength(10);
    const rows = await fx.pppoeRepo.findByUsernames(users);
    expect(rows.filter(r => r.nasId === fx.nasB.id)).toHaveLength(10);
    expect(rows.filter(r => r.nasId === NAS_A)).toHaveLength(5);
  });
});

describe('AutoMovePppoe — cooldown anti-revert (D-W2.5 item 2, C2a)', () => {
  it("evento 'moved' MANUAL reciente (< 10 min) → skippedCooldown, CERO move (no deshacer un move manual recién hecho)", async () => {
    const fx = await buildFixture({ globalSessions: [session('user1', NAS_B_IP)] });
    const s = await seedService(fx);
    // Move manual recién hecho (con kick fallido la sesión VIEJA sigue viva → mismatch aparente).
    await fx.moveEvents.record({
      username: 'user1', pppoeServiceId: s.id, fromNasId: '2', toNasId: NAS_A,
      fromIp: null, toIp: OLD_IP, trigger: 'manual', outcome: 'moved',
      reason: 'kick_failed', actorName: 'operador',
    });

    const summary = await fx.uc.run();

    expect(summary).toEqual({ ...ZERO, sessions: 1, mismatches: 1, skippedCooldown: 1 });
    expect(fx.orchestrator.calls.filter(c => c.op === 'changeFramedIp')).toHaveLength(0);
    expect(fx.moveEvents.all()).toHaveLength(1); // solo la fila manual pre-sembrada (el cooldown NO registra)
    const row = await fx.pppoeRepo.findById(s.id);
    expect(row!.nasId).toBe(NAS_A);
  });

  it('cooldown EXPIRADO (> 10 min) → el move procede normal', async () => {
    let clock = new Date('2026-07-02T00:00:00Z');
    const moveEvents = new InMemoryPppoeNasMoveEventRepository({ now: () => clock });
    const fx = await buildFixture({
      globalSessions: [session('user1', NAS_B_IP, '2026-07-01T23:00:00Z')],
      moveEvents,
      now: () => clock,
    });
    await seedService(fx);
    await fx.moveEvents.record({
      username: 'user1', trigger: 'manual', outcome: 'moved', fromNasId: '2', toNasId: NAS_A,
      fromIp: null, toIp: OLD_IP, actorName: 'operador',
    }); // moved @ 00:00

    clock = new Date('2026-07-02T00:11:00Z'); // +11 min > cooldown de 10
    const summary = await fx.uc.run();

    expect(summary.skippedCooldown).toBe(0);
    expect(summary.moved).toBe(1);
  });
});

describe('AutoMovePppoe — re-verificación pre-execute (D-W2.5 item 3, C2b/S10)', () => {
  it('re-fetch del servicio: ya está en el NAS target → alreadyConverged, CERO move y CERO moved++ (summary honesto)', async () => {
    const fx = await buildFixture({ globalSessions: [session('user1', NAS_B_IP)] });
    const s = await seedService(fx);
    // Move manual CRUZADO después del snapshot batch: el findById fresco ya ve el target.
    const freshRow = { ...(await fx.pppoeRepo.findById(s.id))!, nasId: fx.nasB.id };
    fx.pppoeRepo.findById = async () => freshRow;

    const summary = await fx.uc.run();

    expect(summary).toEqual({ ...ZERO, sessions: 1, mismatches: 1, alreadyConverged: 1 });
    expect(fx.orchestrator.calls.filter(c => c.op === 'changeFramedIp')).toHaveLength(0);
    expect(fx.moveEvents.all()).toHaveLength(0); // ni fila moved (no hubo move) ni skips
  });

  it('re-fetch de sesiones: el ganador fresco ya NO apunta al target (re-auth cruzada) → skip, CERO move', async () => {
    const fx = await buildFixture({
      globalSessions: [session('user1', NAS_B_IP)],
      // El GET /users/user1/sessions fresco muestra la re-auth de vuelta en el NAS asignado.
      perUserSessions: { user1: [session('user1', NAS_A_IP, '2026-07-02T11:00:00Z')] },
    });
    const s = await seedService(fx);

    const summary = await fx.uc.run();

    expect(summary).toEqual({ ...ZERO, sessions: 1, mismatches: 1 });
    expect(fx.orchestrator.calls.filter(c => c.op === 'changeFramedIp')).toHaveLength(0);
    expect(fx.moveEvents.all()).toHaveLength(0);
    const row = await fx.pppoeRepo.findById(s.id);
    expect(row!.nasId).toBe(NAS_A);
  });
});

describe('AutoMovePppoe — freshness de la sesión ganadora (D-W2.5 item 4, C1)', () => {
  it('única sesión con actividad de hace 5 días → skipped_stale_session (fila) + CERO move; 2 ticks → 1 fila (throttle)', async () => {
    // C1: una sesión colgada (acctstoptime NULL viejo) como ÚNICA sesión movería a un cliente
    // OFFLINE al NAS fantasma → sin internet al volver, invisible. El wire de /sessions NO trae
    // lastUpdate/acctupdatetime (verificado en schemas/session.py) → fallback startedAt.
    const STALE_STARTED = '2026-06-27T12:00:00Z'; // 120h antes de FIXED_NOW > umbral 72h
    const fx = await buildFixture({ globalSessions: [session('user1', NAS_B_IP, STALE_STARTED)] });
    const s = await seedService(fx);

    const first = await fx.uc.run();
    const second = await fx.uc.run();

    expect(first).toEqual({ ...ZERO, sessions: 1, mismatches: 1, skippedStale: 1 });
    expect(second).toEqual({ ...ZERO, sessions: 1, mismatches: 1, skippedStale: 1, throttled: 1 });
    expect(fx.orchestrator.calls.filter(c => c.op === 'changeFramedIp')).toHaveLength(0);

    const rows = fx.moveEvents.all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      username: 'user1',
      fromNasId: NAS_A,
      toNasId: fx.nasB.id,
      trigger: 'auto',
      outcome: 'skipped_stale_session',
      reason: 'winner_session_stale_gt_72h',
      actorName: 'sistema',
    });
    const row = await fx.pppoeRepo.findById(s.id);
    expect(row!.nasId).toBe(NAS_A);
  });

  it('sesión con actividad reciente (2h) → NO es stale, el move procede (el gate no mata al watcher)', async () => {
    const fx = await buildFixture({ globalSessions: [session('user1', NAS_B_IP)] }); // startedAt 10:00Z vs now 12:00Z
    await seedService(fx);

    const summary = await fx.uc.run();

    expect(summary.skippedStale).toBe(0);
    expect(summary.moved).toBe(1);
  });
});

describe('AutoMovePppoe — terminated pre-filter (D-W2.5 item 6, W4)', () => {
  it('terminated con sesión viva → skippedTerminated, CERO fila, CERO core call, CERO failed', async () => {
    // W4: sin el pre-filtro, el core rechaza con PppoeServiceTerminatedError y el watcher
    // contaba failed++ ETERNO (cada tick, invisible: el guard de input no persiste fila).
    const fx = await buildFixture({ globalSessions: [session('zombie', NAS_B_IP)] });
    await seedService(fx, { username: 'zombie', status: 'terminated', remoteAddress: null });

    const summary = await fx.uc.run();

    expect(summary).toEqual({ ...ZERO, sessions: 1, skippedTerminated: 1 });
    expect(fx.orchestrator.calls).toHaveLength(0);
    expect(fx.moveEvents.all()).toHaveLength(0);
  });
});

describe('AutoMovePppoe — throttle v2 (D-W2.5 item 7, W5/W6/S9)', () => {
  it('W5: perez1/perez10 — match EXACTO del username: cada uno registra SU fila y el duplicado real SÍ se suprime', async () => {
    // El filtro `username` del repo es contains → el "último evento de perez1" devolvía la fila
    // de perez10 (más nueva) y el guard de igualdad hacía fail-open → fila duplicada CADA tick.
    let t = Date.parse('2026-07-02T12:00:00Z');
    const clock = () => new Date((t += 1000)); // reloj que AVANZA: orden newest-first determinístico
    const moveEvents = new InMemoryPppoeNasMoveEventRepository({ now: clock });
    const fx = await buildFixture({
      globalSessions: [session('perez1', NAS_B_IP), session('perez10', NAS_B_IP)],
      moveEvents,
      now: clock,
    });
    await seedService(fx, { username: 'perez1', remoteAddress: '190.15.242.10' });
    await seedService(fx, { username: 'perez10', remoteAddress: '190.15.242.11' });

    const first = await fx.uc.run();
    const second = await fx.uc.run();

    expect(first).toEqual({ ...ZERO, sessions: 2, mismatches: 2, skippedPublic: 2 });
    expect(second).toEqual({ ...ZERO, sessions: 2, mismatches: 2, skippedPublic: 2, throttled: 2 });
    const rows = fx.moveEvents.all().filter(e => e.outcome === 'skipped_public');
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.username).sort()).toEqual(['perez1', 'perez10']);
  });

  it("W6: último evento IDÉNTICO pero trigger MANUAL → NO suprime (solo un evento 'auto' throttlea al watcher)", async () => {
    const fx = await buildFixture({ globalSessions: [session('user1', NAS_B_IP)] });
    await seedService(fx, { remoteAddress: '190.15.242.10' });
    await fx.moveEvents.record({
      username: 'user1', pppoeServiceId: 'svc-x', fromNasId: NAS_A, toNasId: fx.nasB.id,
      fromIp: '190.15.242.10', toIp: null, trigger: 'manual', outcome: 'skipped_public',
      reason: 'public_pool', actorName: 'operador',
    });

    const summary = await fx.uc.run();

    expect(summary.skippedPublic).toBe(1);
    expect(summary.throttled).toBe(0);
    expect(fx.moveEvents.all().filter(e => e.outcome === 'skipped_public')).toHaveLength(2);
  });

  it('S9: mismo outcome+toNasId pero reason DISTINTO → NO suprime (la comparación incluye reason)', async () => {
    const fx = await buildFixture({ globalSessions: [session('user1', NAS_B_IP)] });
    await seedService(fx, { remoteAddress: '190.15.242.10' }); // hoy clasifica public_pool
    await fx.moveEvents.record({
      username: 'user1', pppoeServiceId: 'svc-x', fromNasId: NAS_A, toNasId: fx.nasB.id,
      fromIp: '190.15.242.10', toIp: null, trigger: 'auto', outcome: 'skipped_public',
      reason: 'unclassified_ip', actorName: 'sistema', // ayer el pool público no estaba cargado
    });

    const summary = await fx.uc.run();

    expect(summary.throttled).toBe(0);
    expect(fx.moveEvents.all().filter(e => e.outcome === 'skipped_public')).toHaveLength(2);
    expect(fx.moveEvents.all().map(e => e.reason).sort()).toEqual(['public_pool', 'unclassified_ip']);
  });

  it('S9: el check del throttle LANZA (DB hiccup) → FAIL-OPEN: la fila se registra igual', async () => {
    const fx = await buildFixture({ globalSessions: [session('user1', NAS_B_IP)] });
    await seedService(fx, { remoteAddress: '190.15.242.10' });
    const realRecord = fx.moveEvents.record.bind(fx.moveEvents);
    fx.moveEvents.list = async () => { throw new Error('db hiccup'); };
    fx.moveEvents.record = realRecord; // record sigue sano: solo el CHECK (list) está roto

    const summary = await fx.uc.run();

    expect(summary.skippedPublic).toBe(1);
    expect(summary.throttled).toBe(0);
    expect(fx.moveEvents.all().filter(e => e.outcome === 'skipped_public')).toHaveLength(1);
  });
});
