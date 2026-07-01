/**
 * MovePppoeToNas use case — TDD tests (pppoe-move-nas W1, design D1/D2/D6).
 *
 * Matriz spec.md:
 *   S1.1 radius→radius: changeFramedIp(username, IP libre del pool cgnat del destino)
 *        + persist nasId destino / remoteAddress nueva / ipMode='fixed'
 *   S1.2 mismo NAS destino → no-op (ni RADIUS ni DB ni eventos)
 *   S1.3 pools cgnat del destino LLENOS → NoFreeIpError, NADA cambió + evento failed_no_free_ip
 *   S1.4 changeFramedIp falla → propaga, DB intacta + evento failed_orchestrator
 *   S2.1 move exitoso → disconnectSessions DESPUÉS de persistir
 *   S2.2 disconnectSessions falla → el move devuelve éxito igual (best-effort)
 *   S3.1 ambos radius → CERO llamadas al PppoeRouterGateway
 *   S3.2 ambos legacy → flujo viejo intacto (createSecret destino + removeSecret origen), IP intacta
 *   S3.3 mixto radius↔legacy → PppoeMoveMixedNasTypesError, nada cambió
 *   S8.1 move manual con contrato → evento historial 'modified' con actor y detalle from/to
 *   S10.1 move manual exitoso → PppoeNasMoveEvent {trigger:'manual', outcome:'moved', fromIp, toIp, actorName}
 *   + guard: servicio terminated → PppoeServiceTerminatedError, nada tocado
 */
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
import {
  PppoeServiceNotFoundError,
  NasNotFoundError,
  PppoeMoveMixedNasTypesError,
  PppoeServiceTerminatedError,
  OrchestratorUnreachableError,
} from '@domain/errors/pppoe';
import { NoFreeIpError } from '@domain/errors/network';

const NAS_RADIUS_A = '3'; // seed InMemoryNasRepository: radius_orchestrator
const NAS_MK       = '1'; // seed InMemoryNasRepository: mikrotik_api (legacy)

const OLD_IP = '100.64.60.25';

/** Orchestrator cuyo kick (disconnectSessions) SIEMPRE falla — para S2.2. */
class KickFailsOrchestrator extends InMemoryRadiusOrchestratorGateway {
  override async disconnectSessions(_username: string): Promise<void> {
    throw new OrchestratorUnreachableError('in-memory', 'CoA-Disconnect falló (NAS viejo muerto)');
  }
}

interface Fixture {
  pppoeRepo: InMemoryPppoeServiceRepository;
  nasRepo: InMemoryNasRepository;
  orchestrator: InMemoryRadiusOrchestratorGateway;
  routerGw: InMemoryRouterGateway;
  netRepo: InMemoryIpNetworkRepository;
  moveEvents: InMemoryPppoeNasMoveEventRepository;
  eventRepo: InMemoryContractServiceEventRepository;
  catalogRepo: InMemoryServiceCatalogRepository;
  nasRadiusB: NasServer;
  uc: MovePppoeToNas;
}

async function buildFixture(opts?: {
  orchestrator?: InMemoryRadiusOrchestratorGateway;
  /** IPs ya asignadas en el RADIUS (radreply). Default: solo la primera usable del pool B. */
  assignedIps?: string[];
  /** Rango del pool cgnat del NAS B destino. Default 100.64.43.2–100.64.43.254. */
  poolRange?: { start: string; end: string };
}): Promise<Fixture> {
  const pppoeRepo = new InMemoryPppoeServiceRepository();
  const nasRepo   = new InMemoryNasRepository();
  const routerGw  = new InMemoryRouterGateway();
  const netRepo   = new InMemoryIpNetworkRepository();
  const moveEvents = new InMemoryPppoeNasMoveEventRepository();
  const eventRepo  = new InMemoryContractServiceEventRepository();
  const catalogRepo = new InMemoryServiceCatalogRepository();
  await catalogRepo.create({ name: 'INTERNET' });

  const orchestrator = opts?.orchestrator
    ?? new InMemoryRadiusOrchestratorGateway({ assignedIps: opts?.assignedIps ?? ['100.64.43.2', OLD_IP] });

  // NAS destino radius con su pool cgnat (100.64.43.0/24 por default).
  const nasRadiusB = await nasRepo.createNasServer({
    name: 'NAS Radius B',
    type: 'radius_orchestrator',
    ipAddress: '10.0.0.6',
    radiusSecret: 'x',
    nasIpAddress: '10.0.0.6',
    apiPort: null,
    apiLogin: null,
    apiPassword: null,
    status: 'active',
    lastSeen: null,
    clientCount: 0,
    description: 'destino radius',
  });
  netRepo.seedNetwork({
    id: 'net-b',
    network: '100.64.43.0/24',
    gateway: '100.64.43.1',
    dns1: '8.8.8.8',
    dns2: '8.8.4.4',
    description: 'CGNAT NAS B',
    partnerId: null,
    type: 'pppoe',
    totalIps: 254,
    usedIps: null,
    freeIps: null,
  });
  netRepo.seedPool({
    id: 'pool-b',
    name: 'cgnat-nas-b',
    networkId: 'net-b',
    rangeStart: opts?.poolRange?.start ?? '100.64.43.2',
    rangeEnd: opts?.poolRange?.end ?? '100.64.43.254',
    type: 'static',
    assignedCount: null,
    totalCount: 253,
    nasId: nasRadiusB.id,
    ipKind: 'cgnat',
  });

  const findFreeIp = new FindFreeIp(netRepo, nasRepo, routerGw, orchestrator);
  const legacyMove = new MovePppoeServiceToRouter(pppoeRepo, routerGw, nasRepo);
  const uc = new MovePppoeToNas(
    pppoeRepo, nasRepo, orchestrator, findFreeIp, legacyMove, moveEvents, catalogRepo, eventRepo,
  );

  return { pppoeRepo, nasRepo, orchestrator, routerGw, netRepo, moveEvents, eventRepo, catalogRepo, nasRadiusB, uc };
}

async function seedService(
  fx: Fixture,
  overrides: Partial<Parameters<InMemoryPppoeServiceRepository['upsertByUsername']>[0]> = {},
) {
  return fx.pppoeRepo.upsertByUsername({
    username: 'moveuser',
    password: 'secret',
    profile: 'IP-Air-10M',
    remoteAddress: OLD_IP,
    status: 'enabled',
    nasId: NAS_RADIUS_A,
    contractId: null,
    ipMode: 'fixed',
    ...overrides,
  });
}

describe('MovePppoeToNas — radius → radius (REQ-MOVE-1/2)', () => {
  it('S1.1: asigna IP libre del pool cgnat del destino, changeFramedIp + persist nasId/remoteAddress/ipMode', async () => {
    const fx = await buildFixture(); // 100.64.43.2 tomada → la primera libre es .3
    const s = await seedService(fx);

    const moved = await fx.uc.execute({ id: s.id, nasId: fx.nasRadiusB.id }, { actorId: 'op-1', actorName: 'operador' });

    expect(moved.nasId).toBe(fx.nasRadiusB.id);
    expect(moved.remoteAddress).toBe('100.64.43.3');
    expect(moved.ipMode).toBe('fixed');

    const call = fx.orchestrator.calls.find(c => c.op === 'changeFramedIp' && c.username === 'moveuser');
    expect(call).toBeDefined();
    expect((call!.arg as { framedIp: string }).framedIp).toBe('100.64.43.3');

    const row = await fx.pppoeRepo.findById(s.id);
    expect(row!.nasId).toBe(fx.nasRadiusB.id);
    expect(row!.remoteAddress).toBe('100.64.43.3');
    expect(row!.ipMode).toBe('fixed');
  });

  it('S1.1: preserva password/profile/status/contractId/enforcedState al persistir', async () => {
    const fx = await buildFixture();
    const s = await seedService(fx, { contractId: 'c-77' });

    await fx.uc.execute({ id: s.id, nasId: fx.nasRadiusB.id }, { actorName: 'operador' });

    const row = await fx.pppoeRepo.findById(s.id);
    expect(row!.password).toBe('secret');
    expect(row!.profile).toBe('IP-Air-10M');
    expect(row!.status).toBe('enabled');
    expect(row!.contractId).toBe('c-77');
    expect(row!.enforcedState).toBe('active');
  });

  it('S1.2: mismo NAS destino → no-op (ni RADIUS, ni DB, ni eventos)', async () => {
    const fx = await buildFixture();
    const s = await seedService(fx);

    const result = await fx.uc.execute({ id: s.id, nasId: NAS_RADIUS_A }, { actorName: 'operador' });

    expect(result.nasId).toBe(NAS_RADIUS_A);
    expect(result.remoteAddress).toBe(OLD_IP);
    expect(fx.orchestrator.calls).toHaveLength(0);
    expect(fx.moveEvents.all()).toHaveLength(0);
    expect(fx.eventRepo.all()).toHaveLength(0);
  });

  it('S1.3: pools cgnat del destino LLENOS → NoFreeIpError y NADA cambió + evento failed_no_free_ip', async () => {
    // Rango de 2 IPs (.2 y .3), ambas asignadas en el RADIUS → pool lleno.
    const fx = await buildFixture({
      poolRange: { start: '100.64.43.2', end: '100.64.43.3' },
      assignedIps: ['100.64.43.2', '100.64.43.3'],
    });
    const s = await seedService(fx);

    await expect(fx.uc.execute({ id: s.id, nasId: fx.nasRadiusB.id }, { actorName: 'operador' }))
      .rejects.toBeInstanceOf(NoFreeIpError);

    // NADA cambió: ni RADIUS ni DB.
    expect(fx.orchestrator.calls.filter(c => c.op === 'changeFramedIp')).toHaveLength(0);
    expect(fx.orchestrator.calls.filter(c => c.op === 'disconnectSessions')).toHaveLength(0);
    const row = await fx.pppoeRepo.findById(s.id);
    expect(row!.nasId).toBe(NAS_RADIUS_A);
    expect(row!.remoteAddress).toBe(OLD_IP);

    // Registro VISIBLE del fallo (REQ-LOG-1 / S10.2 análogo manual).
    const events = fx.moveEvents.all();
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe('failed_no_free_ip');
    expect(events[0].trigger).toBe('manual');
    expect(events[0].username).toBe('moveuser');
    expect(events[0].toNasId).toBe(fx.nasRadiusB.id);
  });

  it('S1.4: changeFramedIp falla (orchestrator caído) → propaga y la DB NO cambió + evento failed_orchestrator', async () => {
    const orchestrator = new InMemoryRadiusOrchestratorGateway({
      assignedIps: ['100.64.43.2'],
      unreachable: ['moveuser'],
    });
    const fx = await buildFixture({ orchestrator });
    const s = await seedService(fx);

    await expect(fx.uc.execute({ id: s.id, nasId: fx.nasRadiusB.id }, { actorName: 'operador' }))
      .rejects.toBeInstanceOf(OrchestratorUnreachableError);

    const row = await fx.pppoeRepo.findById(s.id);
    expect(row!.nasId).toBe(NAS_RADIUS_A);
    expect(row!.remoteAddress).toBe(OLD_IP);

    const events = fx.moveEvents.all();
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe('failed_orchestrator');
  });

  it('S2.1: move exitoso → disconnectSessions llamado DESPUÉS de changeFramedIp (post-persist kick)', async () => {
    const fx = await buildFixture();
    const s = await seedService(fx);

    await fx.uc.execute({ id: s.id, nasId: fx.nasRadiusB.id }, { actorName: 'operador' });

    const ops = fx.orchestrator.calls.filter(c => c.username === 'moveuser').map(c => c.op);
    const idxChange = ops.indexOf('changeFramedIp');
    const idxKick   = ops.indexOf('disconnectSessions');
    expect(idxChange).toBeGreaterThanOrEqual(0);
    expect(idxKick).toBeGreaterThan(idxChange);
  });

  it('S2.2: disconnectSessions falla → el move devuelve éxito igual y el servicio quedó movido', async () => {
    const orchestrator = new KickFailsOrchestrator({ assignedIps: ['100.64.43.2'] });
    const fx = await buildFixture({ orchestrator });
    const s = await seedService(fx);

    const moved = await fx.uc.execute({ id: s.id, nasId: fx.nasRadiusB.id }, { actorName: 'operador' });

    expect(moved.nasId).toBe(fx.nasRadiusB.id);
    expect(moved.remoteAddress).toBe('100.64.43.3');
    const row = await fx.pppoeRepo.findById(s.id);
    expect(row!.nasId).toBe(fx.nasRadiusB.id);

    // El move quedó registrado como moved a pesar del kick fallido (best-effort).
    const events = fx.moveEvents.all();
    expect(events.map(e => e.outcome)).toContain('moved');
  });

  it('S3.1: ambos radius → CERO llamadas al PppoeRouterGateway (sin create/remove de secrets)', async () => {
    const fx = await buildFixture();
    const createSpy = jest.spyOn(fx.routerGw, 'createSecret');
    const removeSpy = jest.spyOn(fx.routerGw, 'removeSecret');
    const s = await seedService(fx);

    await fx.uc.execute({ id: s.id, nasId: fx.nasRadiusB.id }, { actorName: 'operador' });

    expect(createSpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
  });

  it('S10.1: move manual exitoso → PppoeNasMoveEvent {trigger:manual, outcome:moved, fromIp, toIp, actorName}', async () => {
    const fx = await buildFixture();
    const s = await seedService(fx);

    await fx.uc.execute({ id: s.id, nasId: fx.nasRadiusB.id }, { actorId: 'op-1', actorName: 'operador' });

    const events = fx.moveEvents.all();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      username: 'moveuser',
      pppoeServiceId: s.id,
      fromNasId: NAS_RADIUS_A,
      toNasId: fx.nasRadiusB.id,
      fromIp: OLD_IP,
      toIp: '100.64.43.3',
      trigger: 'manual',
      outcome: 'moved',
      actorName: 'operador',
    });
  });

  it('S8.1: move con contrato → evento historial "modified" con actor y detalle from/to NAS+IP', async () => {
    const fx = await buildFixture();
    const s = await seedService(fx, { contractId: 'c-42' });

    await fx.uc.execute({ id: s.id, nasId: fx.nasRadiusB.id }, { actorId: 'op-1', actorName: 'operador' });

    const events = fx.eventRepo.all();
    expect(events).toHaveLength(1);
    expect(events[0].contractId).toBe('c-42');
    expect(events[0].eventType).toBe('modified');
    expect(events[0].actorId).toBe('op-1');
    expect(events[0].actorName).toBe('operador');
    // Detalle from/to: NAS origen + IP vieja → NAS destino + IP nueva.
    expect(events[0].notes).toContain(OLD_IP);
    expect(events[0].notes).toContain('100.64.43.3');
    expect(events[0].notes).toContain('NAS Radius B');
  });

  it('sin contrato (huérfano) → NO registra evento de historial (pero sí el move event)', async () => {
    const fx = await buildFixture();
    const s = await seedService(fx, { contractId: null });

    await fx.uc.execute({ id: s.id, nasId: fx.nasRadiusB.id }, { actorName: 'operador' });

    expect(fx.eventRepo.all()).toHaveLength(0);
    expect(fx.moveEvents.all()).toHaveLength(1);
  });
});

describe('MovePppoeToNas — ruteo por tipo de NAS (REQ-MOVE-3)', () => {
  it('S3.2: ambos legacy → flujo viejo intacto (createSecret destino + removeSecret origen), IP intacta, cero orchestrator', async () => {
    const fx = await buildFixture();
    const createSpy = jest.spyOn(fx.routerGw, 'createSecret');
    const removeSpy = jest.spyOn(fx.routerGw, 'removeSecret');
    const destinoMk = await fx.nasRepo.createNasServer({
      name: 'MK destino',
      type: 'mikrotik_api',
      ipAddress: '10.0.0.99',
      radiusSecret: 'x',
      nasIpAddress: '10.0.0.99',
      apiPort: 8728,
      apiLogin: 'admin',
      apiPassword: 'pw',
      status: 'active',
      lastSeen: null,
      clientCount: 0,
      description: 'destino legacy',
    });
    const s = await seedService(fx, { username: 'mklegacy', nasId: NAS_MK, remoteAddress: '192.168.1.50' });

    const moved = await fx.uc.execute({ id: s.id, nasId: destinoMk.id }, { actorName: 'operador' });

    expect(moved.nasId).toBe(destinoMk.id);
    expect(moved.remoteAddress).toBe('192.168.1.50'); // el flujo legacy NO reasigna IP
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect((createSpy.mock.calls[0][0] as { ipAddress: string }).ipAddress).toBe('10.0.0.99');
    expect((removeSpy.mock.calls[0][0] as { ipAddress: string }).ipAddress).toBe('192.168.1.1');
    expect(fx.orchestrator.calls).toHaveLength(0);

    // REQ-LOG-1: el intento legacy también queda registrado.
    const events = fx.moveEvents.all();
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe('moved');
    expect(events[0].fromIp).toBe('192.168.1.50');
    expect(events[0].toIp).toBe('192.168.1.50');
  });

  it('S3.3: mixto radius→legacy → PppoeMoveMixedNasTypesError y nada cambió', async () => {
    const fx = await buildFixture();
    const s = await seedService(fx); // origen radius ('3')

    await expect(fx.uc.execute({ id: s.id, nasId: NAS_MK }, { actorName: 'operador' }))
      .rejects.toBeInstanceOf(PppoeMoveMixedNasTypesError);

    expect(fx.orchestrator.calls).toHaveLength(0);
    const row = await fx.pppoeRepo.findById(s.id);
    expect(row!.nasId).toBe(NAS_RADIUS_A);
    expect(row!.remoteAddress).toBe(OLD_IP);
    expect(fx.moveEvents.all()).toHaveLength(0);
  });

  it('S3.3: mixto legacy→radius → PppoeMoveMixedNasTypesError y nada cambió', async () => {
    const fx = await buildFixture();
    const s = await seedService(fx, { username: 'mklegacy', nasId: NAS_MK, remoteAddress: '192.168.1.50' });

    await expect(fx.uc.execute({ id: s.id, nasId: fx.nasRadiusB.id }, { actorName: 'operador' }))
      .rejects.toBeInstanceOf(PppoeMoveMixedNasTypesError);

    expect(fx.orchestrator.calls).toHaveLength(0);
    const row = await fx.pppoeRepo.findById(s.id);
    expect(row!.nasId).toBe(NAS_MK);
  });
});

describe('MovePppoeToNas — guards', () => {
  it('servicio inexistente → PppoeServiceNotFoundError', async () => {
    const fx = await buildFixture();
    await expect(fx.uc.execute({ id: 'ghost', nasId: fx.nasRadiusB.id }))
      .rejects.toBeInstanceOf(PppoeServiceNotFoundError);
  });

  it('NAS destino inexistente → NasNotFoundError', async () => {
    const fx = await buildFixture();
    const s = await seedService(fx);
    await expect(fx.uc.execute({ id: s.id, nasId: 'ghost-nas' }))
      .rejects.toBeInstanceOf(NasNotFoundError);
  });

  it('servicio terminated → PppoeServiceTerminatedError, nada tocado', async () => {
    const fx = await buildFixture();
    const s = await seedService(fx, { status: 'terminated' });

    await expect(fx.uc.execute({ id: s.id, nasId: fx.nasRadiusB.id }))
      .rejects.toBeInstanceOf(PppoeServiceTerminatedError);

    expect(fx.orchestrator.calls).toHaveLength(0);
    expect(fx.moveEvents.all()).toHaveLength(0);
  });
});
