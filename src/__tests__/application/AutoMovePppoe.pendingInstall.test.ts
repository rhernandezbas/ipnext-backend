/**
 * pppoe-preprovision-autoinstall — AutoMovePppoe rama "pending install" (tasks 1.4, REQ-PRE-3
 * + D6 endurecimiento post-review, items 1/2/3/10).
 *
 * Un servicio con nasId===null y sesión viva NO es mismatch: es ADOPCIÓN. Defensas del W2
 * compartidas SALVO las excepciones deliberadas del D6:
 *   S3.1 pendiente + sesión fresca en NAS X → adoptado: nasId=X, IP del pool cgnat de X, kick,
 *        evento moved con reason 'auto_install' y actor 'sistema'.
 *   S3.2 pendiente 'public' + NAS X con pool público → IP del pool público.
 *   S3.3 pendiente 'public' + NAS sin pool público → fila failed_no_free_ip visible, servicio
 *        intacto (sigue pendiente).
 *   S3.4 pendiente con sesiones en 2 NAS → skipped_nas_conflict, sin adopción.
 *   S3.5 (D6.2) pendiente con única sesión vieja (>72h) → SE ADOPTA igual: un username
 *        pre-provisionado es NUEVO (no existen colgadas históricas de él) y una sesión vieja
 *        en el pool preinstall = el CPE instalado ESPERANDO (instalado lunes, flag ON jueves).
 *        El freshness sigue intacto para mismatches NORMALES (regresión abajo + W2 suite).
 *   S3.6 las adopciones cuentan para el CAP del tick (compartido con los moves) pero NO para
 *        el abort-threshold (D6.1: se cuentan APARTE en summary.adoptions).
 *   S3.7 flag OFF → cero adopciones (el scheduler gatea el tick; el pendiente queda visible).
 *
 * D6 (fix wave):
 *   D6.1 pendientes acumulados NO abortan el tick (el breaker mira SOLO mismatches reales);
 *        el cap los drena de a maxMovesPerTick con deferred. Mismatches reales > umbral SÍ
 *        abortan el tick ENTERO (adopciones incluidas — regresión del breaker).
 *   D6.3 anti-starvation del cap: BAJO PRESIÓN de cap, un candidato cuyo último evento es un
 *        failed_* idéntico (<6h, mismo toNas, username exacto) NO consume slot
 *        (skippedRecentFailure, sin fila). SIN presión, el retry barato de D-W2.2 sigue intacto.
 *   D6.10 auto_install_kick_failed + cooldown sobre adopción.
 */
import { AutoMovePppoe } from '@application/use-cases/AutoMovePppoe';
import { MovePppoeToNas } from '@application/use-cases/MovePppoeToNas';
import { MovePppoeServiceToRouter } from '@application/use-cases/MovePppoeServiceToRouter';
import { FindFreeIp } from '@application/use-cases/FindFreeIp';
import { PppoeAutoMoveScheduler } from '@infrastructure/scheduling/PppoeAutoMoveScheduler';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { InMemoryRouterGateway } from '@infrastructure/adapters/in-memory/InMemoryRouterGateway';
import { InMemoryIpNetworkRepository } from '@infrastructure/adapters/in-memory/InMemoryIpNetworkRepository';
import { InMemoryPppoeNasMoveEventRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeNasMoveEventRepository';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryFeatureFlagRepository } from '@infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { InMemoryDistributedLock } from '@infrastructure/adapters/in-memory/InMemoryDistributedLock';
import type { NasServer } from '@domain/entities/nas';
import type { OrchestratorSession } from '@domain/ports/RadiusOrchestratorGateway';
import { OrchestratorUnreachableError } from '@domain/errors/pppoe';

const NAS_A    = '3';        // seed InMemoryNasRepository: radius_orchestrator
const NAS_B_IP = '10.0.0.6';
const NAS_D_IP = '10.0.0.8'; // NAS solo-cgnat (sin pool público)
const OLD_IP   = '100.64.60.25'; // en pool-a (cgnat del NAS A) — para el mismatch normal de S3.6

/** Reloj FIJO (patrón AutoMovePppoe.test): sesiones default (10:00Z) frescas para el gate de 72h. */
const FIXED_NOW = new Date('2026-07-02T12:00:00Z');

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
  nasB: NasServer;
  nasD: NasServer;
  uc: AutoMovePppoe;
}

async function buildFixture(opts?: {
  globalSessions?: OrchestratorSession[];
  maxMovesPerTick?: number;
  /** D6.1: umbral del breaker inyectable (default 25) para la regresión con mixes chicos. */
  abortThreshold?: number;
  /** D6.3: reloj compartido watcher+eventos (para sembrar un failed_* "de hace 1h"). */
  now?: () => Date;
}): Promise<Fixture> {
  const now = opts?.now ?? (() => FIXED_NOW);
  const pppoeRepo  = new InMemoryPppoeServiceRepository();
  const nasRepo    = new InMemoryNasRepository();
  const routerGw   = new InMemoryRouterGateway();
  const netRepo    = new InMemoryIpNetworkRepository();
  const moveEvents = new InMemoryPppoeNasMoveEventRepository({ now });
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

  const orchestrator = new InMemoryRadiusOrchestratorGateway({
    assignedIps: ['100.64.43.2', '190.15.242.2', OLD_IP],
    globalSessions,
    seed: [...perUser.entries()].map(([username, sessions]) => ({ username, sessions })),
  });

  const mkNas = (name: string, ip: string) => nasRepo.createNasServer({
    name, type: 'radius_orchestrator', ipAddress: ip, radiusSecret: 'x', nasIpAddress: ip,
    apiPort: null, apiLogin: null, apiPassword: null, status: 'active', lastSeen: null,
    clientCount: 0, description: '',
  });
  const nasB = await mkNas('NAS Radius B', NAS_B_IP);
  const nasD = await mkNas('NAS Radius D (solo cgnat)', NAS_D_IP);

  // Pools del NAS B: cgnat + public.
  netRepo.seedNetwork({
    id: 'net-b', network: '100.64.43.0/24', gateway: '100.64.43.1', dns1: '8.8.8.8', dns2: '8.8.4.4',
    description: 'CGNAT B', partnerId: null, type: 'pppoe', totalIps: 254, usedIps: null, freeIps: null,
  });
  netRepo.seedPool({
    id: 'pool-b-cg', name: 'cgnat-b', networkId: 'net-b',
    rangeStart: '100.64.43.2', rangeEnd: '100.64.43.254',
    type: 'static', assignedCount: null, totalCount: 253, nasId: nasB.id, ipKind: 'cgnat',
  });
  netRepo.seedNetwork({
    id: 'net-pub', network: '190.15.242.0/24', gateway: '190.15.242.1', dns1: '8.8.8.8', dns2: '8.8.4.4',
    description: 'Públicas B', partnerId: null, type: 'pppoe', totalIps: 254, usedIps: null, freeIps: null,
  });
  netRepo.seedPool({
    id: 'pool-b-pub', name: 'publicas-b', networkId: 'net-pub',
    rangeStart: '190.15.242.2', rangeEnd: '190.15.242.254',
    type: 'static', assignedCount: null, totalCount: 253, nasId: nasB.id, ipKind: 'public',
  });
  // Pool del NAS D: SOLO cgnat (S3.3: preferencia public sin pool público).
  netRepo.seedPool({
    id: 'pool-d-cg', name: 'cgnat-d', networkId: 'net-b',
    rangeStart: '100.64.43.2', rangeEnd: '100.64.43.254',
    type: 'static', assignedCount: null, totalCount: 253, nasId: nasD.id, ipKind: 'cgnat',
  });
  // Pool cgnat del NAS A (origen del mismatch normal de S3.6) cubriendo OLD_IP.
  netRepo.seedNetwork({
    id: 'net-a', network: '100.64.60.0/24', gateway: '100.64.60.1', dns1: '8.8.8.8', dns2: '8.8.4.4',
    description: 'CGNAT NAS A', partnerId: null, type: 'pppoe', totalIps: 254, usedIps: null, freeIps: null,
  });
  netRepo.seedPool({
    id: 'pool-a', name: 'cgnat-nas-a', networkId: 'net-a',
    rangeStart: '100.64.60.2', rangeEnd: '100.64.60.254',
    type: 'static', assignedCount: null, totalCount: 253, nasId: NAS_A, ipKind: 'cgnat',
  });

  const findFreeIp = new FindFreeIp(netRepo, nasRepo, routerGw, orchestrator);
  const legacyMove = new MovePppoeServiceToRouter(pppoeRepo, routerGw, nasRepo);
  // Reloj FIJO también en el CORE (throttle de registro determinístico — patrón AutoMovePppoe.test).
  const move = new MovePppoeToNas(
    pppoeRepo, nasRepo, orchestrator, findFreeIp, legacyMove, moveEvents, catalogRepo, eventRepo, netRepo, now,
  );
  const uc = new AutoMovePppoe(
    orchestrator, nasRepo, pppoeRepo, netRepo, moveEvents, move,
    {
      now,
      ...(opts?.maxMovesPerTick !== undefined ? { maxMovesPerTick: opts.maxMovesPerTick } : {}),
      ...(opts?.abortThreshold !== undefined ? { abortThreshold: opts.abortThreshold } : {}),
    },
  );

  return { pppoeRepo, nasRepo, orchestrator, netRepo, moveEvents, nasB, nasD, uc };
}

/** Siembra un PENDIENTE de instalación (nasId null, sin IP). */
async function seedPending(
  fx: Fixture,
  ipTypePreference: 'cgnat' | 'public',
  username = 'pend1',
) {
  return fx.pppoeRepo.upsertByUsername({
    username,
    password: 'secret',
    profile: 'IP-Air-10M',
    remoteAddress: null,
    status: 'enabled',
    nasId: null,
    contractId: null,
    ipMode: 'fixed',
    ipTypePreference,
  });
}

describe('AutoMovePppoe — rama pending install (REQ-PRE-3)', () => {
  it("S3.1: pendiente + sesión fresca en NAS B → adoptado con IP cgnat de B + kick + evento moved reason 'auto_install' actor 'sistema'", async () => {
    const fx = await buildFixture({ globalSessions: [session('pend1', NAS_B_IP)] });
    const s = await seedPending(fx, 'cgnat');

    const summary = await fx.uc.run();

    // D6.1: la adopción se cuenta APARTE (no es un mismatch — no alimenta el breaker).
    expect(summary.adoptions).toBe(1);
    expect(summary.mismatches).toBe(0);
    expect(summary.moved).toBe(1);
    expect(summary.failed).toBe(0);

    const row = await fx.pppoeRepo.findById(s.id);
    expect(row!.nasId).toBe(fx.nasB.id);
    expect(row!.remoteAddress).toBe('100.64.43.3'); // .2 tomada → primera libre
    expect(row!.ipMode).toBe('fixed');

    // Kick best-effort ejecutado (re-auth con la Framed-IP definitiva).
    expect(fx.orchestrator.calls.some(c => c.op === 'disconnectSessions' && c.username === 'pend1')).toBe(true);

    // Evento del tab: moved / auto / auto_install / sistema / fromNas null (outcome SIN cambios).
    const events = fx.moveEvents.all();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      username: 'pend1',
      fromNasId: null,
      toNasId: fx.nasB.id,
      fromIp: null,
      toIp: '100.64.43.3',
      trigger: 'auto',
      outcome: 'moved',
      reason: 'auto_install',
      actorName: 'sistema',
    });
  });

  it("S3.2: pendiente 'public' + NAS B con pool público → la IP sale del pool PÚBLICO", async () => {
    const fx = await buildFixture({ globalSessions: [session('pend1', NAS_B_IP)] });
    const s = await seedPending(fx, 'public');

    const summary = await fx.uc.run();

    expect(summary.moved).toBe(1);
    const row = await fx.pppoeRepo.findById(s.id);
    expect(row!.nasId).toBe(fx.nasB.id);
    expect(row!.remoteAddress).toBe('190.15.242.3'); // pool public: .2 tomada → primera libre
  });

  it("S3.3: pendiente 'public' + NAS D SIN pool público → fila failed_no_free_ip, servicio intacto (sigue pendiente)", async () => {
    const fx = await buildFixture({ globalSessions: [session('pend1', NAS_D_IP)] });
    const s = await seedPending(fx, 'public');

    const summary = await fx.uc.run();

    expect(summary.moved).toBe(0);
    expect(summary.failed).toBe(1);

    // El core (MovePppoeToNas) registró el fallo VISIBLE — NoPoolForNasTypeError → failed_no_free_ip.
    const events = fx.moveEvents.all();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      username: 'pend1',
      outcome: 'failed_no_free_ip',
      trigger: 'auto',
      toNasId: fx.nasD.id,
      fromNasId: null,
      actorName: 'sistema',
    });

    const row = await fx.pppoeRepo.findById(s.id);
    expect(row!.nasId).toBeNull();
    expect(row!.remoteAddress).toBeNull();
  });

  it('S3.4: pendiente con sesiones vivas en 2 NAS distintos → skipped_nas_conflict, sin adopción', async () => {
    const fx = await buildFixture({
      globalSessions: [session('pend1', NAS_B_IP), session('pend1', NAS_D_IP)],
    });
    const s = await seedPending(fx, 'cgnat');

    const summary = await fx.uc.run();

    expect(summary.moved).toBe(0);
    expect(summary.nasConflicts).toBe(1);

    const events = fx.moveEvents.all();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ username: 'pend1', outcome: 'skipped_nas_conflict' });

    const row = await fx.pppoeRepo.findById(s.id);
    expect(row!.nasId).toBeNull();
  });

  it('S3.5 (D6.2): pendiente con única sesión VIEJA (>72h) → SE ADOPTA igual (exenta del freshness gate)', async () => {
    // D6.2: un username pre-provisionado es NUEVO — no pueden existir sesiones colgadas
    // históricas de él; la sesión "vieja" en el pool preinstall es el CPE instalado ESPERANDO
    // (instalado lunes, flag ON jueves). Peor caso = adoptar con el cliente ya offline →
    // converge solo cuando vuelve. El guard multi-NAS (S3.4) SÍ sigue aplicando.
    const fx = await buildFixture({
      globalSessions: [session('pend1', NAS_B_IP, '2026-06-20T10:00:00Z')], // 12 días > 72h
    });
    const s = await seedPending(fx, 'cgnat');

    const summary = await fx.uc.run();

    expect(summary.skippedStale).toBe(0);
    expect(summary.adoptions).toBe(1);
    expect(summary.moved).toBe(1);

    const row = await fx.pppoeRepo.findById(s.id);
    expect(row!.nasId).toBe(fx.nasB.id);
    expect(row!.remoteAddress).toBe('100.64.43.3');

    const events = fx.moveEvents.all();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ username: 'pend1', outcome: 'moved', reason: 'auto_install' });
  });

  it('S3.6 (D6.1): la adopción cuenta para el CAP del tick pero APARTE del breaker — 1 move + 1 deferred', async () => {
    const fx = await buildFixture({
      // pend1 (adopción) + user2 (mismatch normal NAS A → B), cap de 1 move por tick.
      globalSessions: [session('pend1', NAS_B_IP), session('user2', NAS_B_IP)],
      maxMovesPerTick: 1,
    });
    await seedPending(fx, 'cgnat');
    const s2 = await fx.pppoeRepo.upsertByUsername({
      username: 'user2', password: 'x', profile: 'P1', remoteAddress: OLD_IP,
      status: 'enabled', nasId: NAS_A, contractId: null, ipMode: 'fixed',
      ipTypePreference: 'cgnat', // pppoe-preprovision: explícito (default de las filas legacy)
    });

    const summary = await fx.uc.run();

    // D6.1: contadores separados — la adopción NO suma al breaker, pero SÍ compite por el cap.
    expect(summary.adoptions).toBe(1);
    expect(summary.mismatches).toBe(1);
    expect(summary.moved).toBe(1);
    expect(summary.deferred).toBe(1);

    // La adopción consumió el cupo del tick; el mismatch normal quedó para el próximo.
    const row2 = await fx.pppoeRepo.findById(s2.id);
    expect(row2!.nasId).toBe(NAS_A);
  });

  it('S3.7: flag pppoe-auto-move OFF → el tick ni corre (cero adopciones, el pendiente queda visible)', async () => {
    const fx = await buildFixture({ globalSessions: [session('pend1', NAS_B_IP)] });
    const s = await seedPending(fx, 'cgnat');

    const flags = new InMemoryFeatureFlagRepository();
    flags.seed('pppoe-auto-move', false);
    const scheduler = new PppoeAutoMoveScheduler(
      fx.uc, { intervalMs: 1000, silent: true }, new InMemoryDistributedLock(), flags,
    );

    const result = await scheduler.runOnce();
    expect(result.skipped).toBe(true);

    const row = await fx.pppoeRepo.findById(s.id);
    expect(row!.nasId).toBeNull();
    expect(fx.moveEvents.all()).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// D6 — Endurecimiento post-review (fix wave): breaker vs adopciones, freshness, anti-starvation
// ════════════════════════════════════════════════════════════════════════════════════════════

/** Siembra un mismatch NORMAL: servicio en NAS_A con IP cgnat de pool-a + sesión en otro NAS. */
async function seedRealMismatch(fx: Fixture, username: string, lastOctet: number) {
  return fx.pppoeRepo.upsertByUsername({
    username, password: 'x', profile: 'P1', remoteAddress: `100.64.60.${lastOctet}`,
    status: 'enabled', nasId: NAS_A, contractId: null, ipMode: 'fixed', ipTypePreference: 'cgnat',
  });
}

describe('AutoMovePppoe — D6.1: adopciones FUERA del abort-threshold (CRITICAL)', () => {
  it('30 pendientes acumulados + 5 mismatches reales → NO aborta: procesa 10 (cap), deferred=25', async () => {
    // El escenario del CRITICAL: flag OFF unos días = pendientes acumulados (modo ESPERADO
    // pre-go-live). Con el conteo viejo (adopciones dentro de mismatches) 35 > 25 abortaba el
    // tick PARA SIEMPRE: cero adopciones, cero moves, cero filas, cada tick.
    const pendings = Array.from({ length: 30 }, (_, i) => `pend${i}`);
    const reales   = Array.from({ length: 5 },  (_, i) => `real${i}`);
    const fx = await buildFixture({
      globalSessions: [
        ...pendings.map(u => session(u, NAS_B_IP)),
        ...reales.map(u => session(u, NAS_B_IP)),
      ],
    });
    for (const u of pendings) await seedPending(fx, 'cgnat', u);
    for (let i = 0; i < reales.length; i++) await seedRealMismatch(fx, reales[i]!, 30 + i);

    const summary = await fx.uc.run();

    expect(summary.aborted).toBe(false);
    expect(summary.adoptions).toBe(30);
    expect(summary.mismatches).toBe(5); // solo los REALES alimentan el breaker
    expect(summary.moved).toBe(10);     // el cap drena de a 10 por tick
    expect(summary.deferred).toBe(25);
    expect(summary.failed).toBe(0);
    expect(fx.moveEvents.all().filter(e => e.outcome === 'moved')).toHaveLength(10);
  });

  it('regresión del breaker: 6 mismatches REALES (> umbral 5) + 3 pendientes → tick ABORTADO entero (cero moves, cero filas, adopciones incluidas)', async () => {
    const reales   = Array.from({ length: 6 }, (_, i) => `real${i}`);
    const pendings = Array.from({ length: 3 }, (_, i) => `pend${i}`);
    const fx = await buildFixture({
      globalSessions: [
        ...reales.map(u => session(u, NAS_B_IP)),
        ...pendings.map(u => session(u, NAS_B_IP)),
      ],
      abortThreshold: 5,
    });
    for (let i = 0; i < reales.length; i++) await seedRealMismatch(fx, reales[i]!, 30 + i);
    const pendingRows = [];
    for (const u of pendings) pendingRows.push(await seedPending(fx, 'cgnat', u));

    const summary = await fx.uc.run();

    expect(summary.aborted).toBe(true);
    expect(summary.mismatches).toBe(6);
    expect(summary.adoptions).toBe(3);
    expect(summary.moved).toBe(0);
    expect(fx.orchestrator.calls).toHaveLength(0); // ni changeFramedIp ni kicks
    expect(fx.moveEvents.all()).toHaveLength(0);   // el abort no escribe NADA
    for (const p of pendingRows) {
      const row = await fx.pppoeRepo.findById(p.id);
      expect(row!.nasId).toBeNull(); // las adopciones tampoco corrieron
    }
  });
});

describe('AutoMovePppoe — D6.2: freshness intacto para mismatches NORMALES (regresión)', () => {
  it('mismatch normal con única sesión vieja (>72h) → skipped_stale_session, CERO move (la exención es SOLO para adopciones)', async () => {
    const fx = await buildFixture({
      globalSessions: [session('real1', NAS_B_IP, '2026-06-20T10:00:00Z')], // 12 días > 72h
    });
    const s = await seedRealMismatch(fx, 'real1', 40);

    const summary = await fx.uc.run();

    expect(summary.skippedStale).toBe(1);
    expect(summary.moved).toBe(0);
    const events = fx.moveEvents.all();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ username: 'real1', outcome: 'skipped_stale_session' });
    const row = await fx.pppoeRepo.findById(s.id);
    expect(row!.nasId).toBe(NAS_A);
  });
});

describe('AutoMovePppoe — D6.3: anti-starvation del cap', () => {
  it("bajo PRESIÓN de cap, un candidato con failed_* idéntico reciente (<6h, mismo toNas) NO consume slot — los 10 sanos entran", async () => {
    // Sin esto, el 'public' sin pool cargado (falla PERMANENTE) va PRIMERO en el orden de
    // sesiones y quema 1 de los 10 slots CADA tick para siempre — starvation de los sanos.
    let t = new Date('2026-07-02T11:00:00Z'); // 1h antes de FIXED_NOW
    const sanos = Array.from({ length: 10 }, (_, i) => `sano${i}`);
    const fx = await buildFixture({
      globalSessions: [
        session('pfail', NAS_D_IP), // primero en el orden: sin el fix ocuparía el slot 1
        ...sanos.map(u => session(u, NAS_B_IP)),
      ],
      now: () => t,
    });
    const sFail = await seedPending(fx, 'public', 'pfail'); // NAS D no tiene pool público
    for (const u of sanos) await seedPending(fx, 'cgnat', u);
    // La fila que dejó el tick anterior (hace 1h): failed_no_free_ip hacia el MISMO NAS D.
    await fx.moveEvents.record({
      username: 'pfail', pppoeServiceId: sFail.id, fromNasId: null, toNasId: fx.nasD.id,
      fromIp: null, toIp: null, trigger: 'auto', outcome: 'failed_no_free_ip',
      reason: 'NO_POOL_FOR_NAS_TYPE', actorName: 'sistema',
    });
    t = FIXED_NOW; // el tick corre 1h después (dentro de la ventana de 6h)

    const summary = await fx.uc.run();

    expect(summary.skippedRecentFailure).toBe(1);
    expect(summary.moved).toBe(10);   // los 10 sanos entraron al cap
    expect(summary.deferred).toBe(0);
    expect(summary.failed).toBe(0);   // pfail NI se intentó (sin core call)
    // Sin fila nueva para pfail: la del tick anterior sigue siendo la única.
    expect(fx.moveEvents.all().filter(e => e.username === 'pfail')).toHaveLength(1);
    const row = await fx.pppoeRepo.findById(sFail.id);
    expect(row!.nasId).toBeNull();
  });

  it('SIN presión de cap, el retry barato de D-W2.2 sigue intacto (el fallo reciente se reintenta; fila throttled)', async () => {
    let t = new Date('2026-07-02T11:00:00Z');
    const fx = await buildFixture({
      globalSessions: [session('pfail', NAS_D_IP)],
      now: () => t,
    });
    const sFail = await seedPending(fx, 'public', 'pfail');
    await fx.moveEvents.record({
      username: 'pfail', pppoeServiceId: sFail.id, fromNasId: null, toNasId: fx.nasD.id,
      fromIp: null, toIp: null, trigger: 'auto', outcome: 'failed_no_free_ip',
      reason: 'NO_POOL_FOR_NAS_TYPE', actorName: 'sistema',
    });
    t = FIXED_NOW;

    const summary = await fx.uc.run();

    // 1 candidato ≤ cap 10 → sin presión: se reintenta cada tick (converge apenas carguen el pool).
    expect(summary.skippedRecentFailure).toBe(0);
    expect(summary.failed).toBe(1);
    // El registro NO spamea: la fila idéntica queda suprimida por el throttle de 6h del core.
    expect(fx.moveEvents.all().filter(e => e.username === 'pfail')).toHaveLength(1);
  });
});

describe('AutoMovePppoe — D6.10: tests faltantes de la adopción', () => {
  it("kick falla durante la adopción → evento moved con reason 'auto_install_kick_failed' (la pista no se pierde)", async () => {
    const fx = await buildFixture({ globalSessions: [session('pend1', NAS_B_IP)] });
    const s = await seedPending(fx, 'cgnat');
    fx.orchestrator.disconnectSessions = async () => {
      throw new OrchestratorUnreachableError('in-memory');
    };

    const summary = await fx.uc.run();

    expect(summary.moved).toBe(1); // el kick es best-effort: el move NO se revierte
    const row = await fx.pppoeRepo.findById(s.id);
    expect(row!.nasId).toBe(fx.nasB.id);
    const events = fx.moveEvents.all();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      username: 'pend1',
      outcome: 'moved',
      reason: 'auto_install_kick_failed',
      actorName: 'sistema',
    });
  });

  it("cooldown aplica a la adopción: evento 'moved' reciente (<10 min) del username → skippedCooldown, sigue pendiente", async () => {
    const fx = await buildFixture({ globalSessions: [session('pend1', NAS_B_IP)] });
    const s = await seedPending(fx, 'cgnat');
    // Un 'moved' recién registrado del MISMO username (p.ej. adopción manual cruzada cuyo
    // estado espejo todavía no converge): el watcher NO la re-procesa dentro del cooldown.
    await fx.moveEvents.record({
      username: 'pend1', pppoeServiceId: s.id, fromNasId: null, toNasId: NAS_A,
      fromIp: null, toIp: '100.64.60.99', trigger: 'manual', outcome: 'moved',
      reason: null, actorName: 'operador',
    });

    const summary = await fx.uc.run();

    expect(summary.skippedCooldown).toBe(1);
    expect(summary.moved).toBe(0);
    const row = await fx.pppoeRepo.findById(s.id);
    expect(row!.nasId).toBeNull();
    // Solo la fila manual pre-sembrada: el cooldown no registra.
    expect(fx.moveEvents.all()).toHaveLength(1);
  });
});
