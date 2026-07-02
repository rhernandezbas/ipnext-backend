/**
 * pppoe-preprovision-autoinstall — AutoMovePppoe rama "pending install" (tasks 1.4, REQ-PRE-3).
 *
 * Un servicio con nasId===null y sesión viva NO es mismatch: es ADOPCIÓN. Mismas defensas del W2:
 *   S3.1 pendiente + sesión fresca en NAS X → adoptado: nasId=X, IP del pool cgnat de X, kick,
 *        evento moved con reason 'auto_install' y actor 'sistema'.
 *   S3.2 pendiente 'public' + NAS X con pool público → IP del pool público.
 *   S3.3 pendiente 'public' + NAS sin pool público → fila failed_no_free_ip visible, servicio
 *        intacto (sigue pendiente).
 *   S3.4 pendiente con sesiones en 2 NAS → skipped_nas_conflict, sin adopción.
 *   S3.5 pendiente con única sesión vieja (>72h) → skipped_stale_session, sin adopción.
 *   S3.6 las adopciones cuentan para el cap del tick (breaker/cap COMPARTIDOS con los moves).
 *   S3.7 flag OFF → cero adopciones (el scheduler gatea el tick; el pendiente queda visible).
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
}): Promise<Fixture> {
  const now = () => FIXED_NOW;
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
    { now, ...(opts?.maxMovesPerTick !== undefined ? { maxMovesPerTick: opts.maxMovesPerTick } : {}) },
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

    expect(summary.mismatches).toBe(1);
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

  it('S3.5: pendiente con única sesión VIEJA (>72h) → skipped_stale_session, sin adopción', async () => {
    const fx = await buildFixture({
      globalSessions: [session('pend1', NAS_B_IP, '2026-06-20T10:00:00Z')], // 12 días > 72h
    });
    const s = await seedPending(fx, 'cgnat');

    const summary = await fx.uc.run();

    expect(summary.moved).toBe(0);
    expect(summary.skippedStale).toBe(1);

    const events = fx.moveEvents.all();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ username: 'pend1', outcome: 'skipped_stale_session' });

    const row = await fx.pppoeRepo.findById(s.id);
    expect(row!.nasId).toBeNull();
  });

  it('S3.6: la adopción cuenta para el cap del tick (breaker/cap COMPARTIDOS — 1 move + 1 deferred)', async () => {
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

    expect(summary.mismatches).toBe(2);
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
