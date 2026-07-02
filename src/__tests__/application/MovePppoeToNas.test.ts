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
import type { PppoeService } from '@domain/entities/pppoeService';
import type { PppoeServiceUpsert } from '@domain/ports/PppoeServiceRepository';
import {
  PppoeServiceNotFoundError,
  NasNotFoundError,
  PppoeMoveMixedNasTypesError,
  PppoeMovePublicIpError,
  PppoeServiceTerminatedError,
  OrchestratorUnreachableError,
  OrchestratorRejectedError,
  RouterUnreachableError,
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
  /** fix wave 1: repo custom (p.ej. que falla el update post-RADIUS — S1.8). */
  pppoeRepo?: InMemoryPppoeServiceRepository;
  /** fix wave 1: router gateway custom (p.ej. destino legacy caído — failed_router). */
  routerGw?: InMemoryRouterGateway;
}): Promise<Fixture> {
  const pppoeRepo = opts?.pppoeRepo ?? new InMemoryPppoeServiceRepository();
  const nasRepo   = new InMemoryNasRepository();
  const routerGw  = opts?.routerGw ?? new InMemoryRouterGateway();
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
  // fix wave 1 (ajuste 6 / S1.5): pool PUBLIC cargado — clasifica la IP actual del servicio.
  // Rango disjunto de todo lo demás: solo los tests que sientan la IP del servicio acá lo activan.
  netRepo.seedNetwork({
    id: 'net-pub',
    network: '190.15.242.0/24',
    gateway: '190.15.242.1',
    dns1: '8.8.8.8',
    dns2: '8.8.4.4',
    description: 'Públicas corporativas',
    partnerId: null,
    type: 'pppoe',
    totalIps: 254,
    usedIps: null,
    freeIps: null,
  });
  netRepo.seedPool({
    id: 'pool-pub',
    name: 'publicas',
    networkId: 'net-pub',
    rangeStart: '190.15.242.2',
    rangeEnd: '190.15.242.254',
    type: 'static',
    assignedCount: null,
    totalCount: 253,
    nasId: null,
    ipKind: 'public',
  });

  const findFreeIp = new FindFreeIp(netRepo, nasRepo, routerGw, orchestrator);
  const legacyMove = new MovePppoeServiceToRouter(pppoeRepo, routerGw, nasRepo);
  const uc = new MovePppoeToNas(
    pppoeRepo, nasRepo, orchestrator, findFreeIp, legacyMove, moveEvents, catalogRepo, eventRepo, netRepo,
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

  it('S2.1: kick DESPUÉS de PERSISTIR en DB — orden verificable con call-log COMPARTIDO repo↔gateway', async () => {
    // fix wave 1 (ajuste 8c): "después de changeFramedIp" no alcanza — el kick debe ir después
    // del write de DB. El log compartido registra AMBOS lados (RADIUS y DB) en un solo timeline.
    const sharedLog: string[] = [];
    let armed = false; // el seeding también escribe en DB — armar recién antes del move

    class LoggingRepo extends InMemoryPppoeServiceRepository {
      override async setNasAndIp(id: string, nasId: string, remoteAddress: string | null, ipMode: 'pool' | 'fixed'): Promise<PppoeService | null> {
        if (armed) sharedLog.push('db:persist');
        return super.setNasAndIp(id, nasId, remoteAddress, ipMode);
      }
      override async upsertByUsername(data: PppoeServiceUpsert): Promise<PppoeService> {
        if (armed) sharedLog.push('db:persist');
        return super.upsertByUsername(data);
      }
    }
    class LoggingOrchestrator extends InMemoryRadiusOrchestratorGateway {
      override async changeFramedIp(username: string, framedIp: string | null): Promise<void> {
        if (armed) sharedLog.push('radius:changeFramedIp');
        return super.changeFramedIp(username, framedIp);
      }
      override async disconnectSessions(username: string): Promise<void> {
        if (armed) sharedLog.push('radius:kick');
        return super.disconnectSessions(username);
      }
    }

    const pppoeRepo = new LoggingRepo();
    const orchestrator = new LoggingOrchestrator({ assignedIps: ['100.64.43.2', OLD_IP] });
    const fx = await buildFixture({ orchestrator, pppoeRepo });
    const s = await seedService(fx);
    armed = true;

    await fx.uc.execute({ id: s.id, nasId: fx.nasRadiusB.id }, { actorName: 'operador' });

    expect(sharedLog).toEqual(['radius:changeFramedIp', 'db:persist', 'radius:kick']);
  });

  it('S2.2: disconnectSessions falla → el move devuelve éxito igual y el evento moved lleva reason=kick_failed', async () => {
    const orchestrator = new KickFailsOrchestrator({ assignedIps: ['100.64.43.2'] });
    const fx = await buildFixture({ orchestrator });
    const s = await seedService(fx);

    const moved = await fx.uc.execute({ id: s.id, nasId: fx.nasRadiusB.id }, { actorName: 'operador' });

    expect(moved.nasId).toBe(fx.nasRadiusB.id);
    expect(moved.remoteAddress).toBe('100.64.43.3');
    const row = await fx.pppoeRepo.findById(s.id);
    expect(row!.nasId).toBe(fx.nasRadiusB.id);

    // El move quedó registrado como moved a pesar del kick fallido (best-effort)…
    const events = fx.moveEvents.all();
    const movedEvent = events.find(e => e.outcome === 'moved');
    expect(movedEvent).toBeDefined();
    // …pero con PISTA visible (ajuste 7): el operador sabe que el cliente sigue con la IP vieja.
    expect(movedEvent!.reason).toBe('kick_failed');
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

  it('terminated hacia su MISMO NAS → no-op (el no-op va ANTES del guard terminated, ajuste 8a)', async () => {
    const fx = await buildFixture();
    const s = await seedService(fx, { status: 'terminated' }); // nasId = NAS_RADIUS_A

    const result = await fx.uc.execute({ id: s.id, nasId: NAS_RADIUS_A }, { actorName: 'operador' });

    expect(result.nasId).toBe(NAS_RADIUS_A);
    expect(fx.orchestrator.calls).toHaveLength(0);
    expect(fx.moveEvents.all()).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Fix wave 1 (post-review 2026-07-01) — S1.5/S1.6/S1.7/S1.8 + REQ-LOG-1 ampliado
// ════════════════════════════════════════════════════════════════════════════════

/** Orchestrator con snapshot VIEJO: oculta una IP del PRÓXIMO listAssignedIps (simula el TOCTOU
 *  entre el FindFreeIp de un move y el changeFramedIp de otro move concurrente). */
class StaleSnapshotOrchestrator extends InMemoryRadiusOrchestratorGateway {
  /** IP a ocultar del próximo listAssignedIps (una sola vez). */
  hideOnce: string | null = null;
  override async listAssignedIps(): Promise<string[]> {
    const ips = await super.listAssignedIps();
    if (this.hideOnce !== null) {
      const hidden = this.hideOnce;
      this.hideOnce = null;
      return ips.filter(ip => ip !== hidden);
    }
    return ips;
  }
}

/** Orchestrator que SIEMPRE rechaza changeFramedIp con 409 (colisión persistente de Framed-IP). */
class RejectFramedIpOrchestrator extends InMemoryRadiusOrchestratorGateway {
  override async changeFramedIp(username: string, framedIp: string | null): Promise<void> {
    this.calls.push({ op: 'changeFramedIp', username, arg: { framedIp } });
    throw new OrchestratorRejectedError(409, { detail: 'FramedIpAlreadyAssigned' });
  }
}

/** Repo que FALLA todo write una vez armado (simula la DB caída DESPUÉS del write RADIUS — S1.8). */
class DbDownRepo extends InMemoryPppoeServiceRepository {
  failWrites = false;
  override async upsertByUsername(data: PppoeServiceUpsert): Promise<PppoeService> {
    if (this.failWrites) throw new Error('db down (post-RADIUS)');
    return super.upsertByUsername(data);
  }
  override async setNasAndIp(id: string, nasId: string, remoteAddress: string | null, ipMode: 'pool' | 'fixed'): Promise<PppoeService | null> {
    if (this.failWrites) throw new Error('db down (post-RADIUS)');
    return super.setNasAndIp(id, nasId, remoteAddress, ipMode);
  }
}

/** Orchestrator que BORRA la fila del espejo tras el changeFramedIp OK (terminate concurrente — S1.7). */
class DeleteRowAfterRadiusOrchestrator extends InMemoryRadiusOrchestratorGateway {
  onFramedIpWritten: (() => Promise<void>) | null = null;
  override async changeFramedIp(username: string, framedIp: string | null): Promise<void> {
    await super.changeFramedIp(username, framedIp);
    await this.onFramedIpWritten?.();
  }
}

describe('MovePppoeToNas — S1.5: guard de IP PÚBLICA (force explícito)', () => {
  it('IP actual en pool public SIN force → PppoeMovePublicIpError y NADA cambió (sin fila de evento)', async () => {
    const fx = await buildFixture();
    const s = await seedService(fx, { remoteAddress: '190.15.242.10' }); // dentro de pool-pub

    await expect(fx.uc.execute({ id: s.id, nasId: fx.nasRadiusB.id }, { actorName: 'operador' }))
      .rejects.toBeInstanceOf(PppoeMovePublicIpError);

    expect(fx.orchestrator.calls).toHaveLength(0);
    const row = await fx.pppoeRepo.findById(s.id);
    expect(row!.nasId).toBe(NAS_RADIUS_A);
    expect(row!.remoteAddress).toBe('190.15.242.10');
    // Guard de INPUT: responde 4xx directo, NO persiste fila (REQ-LOG-1).
    expect(fx.moveEvents.all()).toHaveLength(0);
  });

  it('IP actual en pool public CON force: true → procede (IP nueva del pool cgnat del destino)', async () => {
    const fx = await buildFixture();
    const s = await seedService(fx, { remoteAddress: '190.15.242.10' });

    const moved = await fx.uc.execute(
      { id: s.id, nasId: fx.nasRadiusB.id, force: true },
      { actorName: 'operador' },
    );

    expect(moved.nasId).toBe(fx.nasRadiusB.id);
    expect(moved.remoteAddress).toBe('100.64.43.3');
    const events = fx.moveEvents.all();
    expect(events.map(e => e.outcome)).toEqual(['moved']);
  });

  it('IP actual CGNAT (no pública) → el move NO exige force (comportamiento base intacto)', async () => {
    const fx = await buildFixture();
    const s = await seedService(fx); // OLD_IP 100.64.60.25, fuera de todo pool public

    const moved = await fx.uc.execute({ id: s.id, nasId: fx.nasRadiusB.id }, { actorName: 'operador' });
    expect(moved.remoteAddress).toBe('100.64.43.3');
  });
});

describe('MovePppoeToNas — S1.6: colisión de Framed-IP (guard autoritativo del orchestrator + retry)', () => {
  it('dos moves al mismo NAS "eligen" la misma IP → el 2º converge a otra tras el rechazo (retry con FindFreeIp fresco)', async () => {
    const orchestrator = new StaleSnapshotOrchestrator({ assignedIps: ['100.64.43.2', OLD_IP] });
    const fx = await buildFixture({ orchestrator });
    const s1 = await seedService(fx); // moveuser
    const s2 = await seedService(fx, { username: 'moveuser2', remoteAddress: '100.64.60.26' });

    // Move 1 toma la .3 (queda registrada como asignada a moveuser en el RADIUS fake).
    await fx.uc.execute({ id: s1.id, nasId: fx.nasRadiusB.id }, { actorName: 'operador' });

    // TOCTOU: el snapshot del move 2 NO ve la .3 recién tomada → también la "elige".
    orchestrator.hideOnce = '100.64.43.3';
    const moved2 = await fx.uc.execute({ id: s2.id, nasId: fx.nasRadiusB.id }, { actorName: 'operador' });

    // El orchestrator rechazó la .3 (guard autoritativo) → retry con snapshot fresco → .4.
    expect(moved2.remoteAddress).toBe('100.64.43.4');
    const attempts = orchestrator.calls
      .filter(c => c.op === 'changeFramedIp' && c.username === 'moveuser2')
      .map(c => (c.arg as { framedIp: string }).framedIp);
    expect(attempts).toEqual(['100.64.43.3', '100.64.43.4']);
    // El 2º move terminó moved (sin fila de fallo intermedia).
    const eventsU2 = fx.moveEvents.all().filter(e => e.username === 'moveuser2');
    expect(eventsU2.map(e => e.outcome)).toEqual(['moved']);
    // Y la DB refleja la IP convergida.
    const row2 = await fx.pppoeRepo.findById(s2.id);
    expect(row2!.remoteAddress).toBe('100.64.43.4');
  });

  it('el 2º intento TAMBIÉN rechazado → evento failed_orchestrator + propaga OrchestratorRejectedError (UN solo retry)', async () => {
    const orchestrator = new RejectFramedIpOrchestrator({ assignedIps: ['100.64.43.2', OLD_IP] });
    const fx = await buildFixture({ orchestrator });
    const s = await seedService(fx);

    await expect(fx.uc.execute({ id: s.id, nasId: fx.nasRadiusB.id }, { actorName: 'operador' }))
      .rejects.toBeInstanceOf(OrchestratorRejectedError);

    // Exactamente 2 intentos (1 original + 1 retry) — nunca un loop.
    const attempts = orchestrator.calls.filter(c => c.op === 'changeFramedIp' && c.username === 'moveuser');
    expect(attempts).toHaveLength(2);
    // UN solo evento failed_orchestrator (el fallo FINAL, no uno por intento).
    const events = fx.moveEvents.all();
    expect(events.map(e => e.outcome)).toEqual(['failed_orchestrator']);
    // La DB no cambió.
    const row = await fx.pppoeRepo.findById(s.id);
    expect(row!.nasId).toBe(NAS_RADIUS_A);
    expect(row!.remoteAddress).toBe(OLD_IP);
  });

  it('rechazo NO-409 (p.ej. 422) → NO reintenta: evento failed_orchestrator + propaga directo', async () => {
    class Reject422Orchestrator extends InMemoryRadiusOrchestratorGateway {
      override async changeFramedIp(username: string, framedIp: string | null): Promise<void> {
        this.calls.push({ op: 'changeFramedIp', username, arg: { framedIp } });
        throw new OrchestratorRejectedError(422, { detail: 'invalid framed ip' });
      }
    }
    const orchestrator = new Reject422Orchestrator({ assignedIps: ['100.64.43.2', OLD_IP] });
    const fx = await buildFixture({ orchestrator });
    const s = await seedService(fx);

    await expect(fx.uc.execute({ id: s.id, nasId: fx.nasRadiusB.id }, { actorName: 'operador' }))
      .rejects.toBeInstanceOf(OrchestratorRejectedError);

    expect(orchestrator.calls.filter(c => c.op === 'changeFramedIp')).toHaveLength(1);
    expect(fx.moveEvents.all().map(e => e.outcome)).toEqual(['failed_orchestrator']);
  });
});

describe('MovePppoeToNas — S1.7: anti-resurrección (update NO-creador)', () => {
  it('fila borrada entre la lectura y la persistencia → typed not-found y CERO filas creadas', async () => {
    const orchestrator = new DeleteRowAfterRadiusOrchestrator({ assignedIps: ['100.64.43.2', OLD_IP] });
    const fx = await buildFixture({ orchestrator });
    const s = await seedService(fx);
    // Terminate concurrente: borra la fila justo DESPUÉS del write RADIUS, ANTES del write DB.
    orchestrator.onFramedIpWritten = async () => { await fx.pppoeRepo.deleteById(s.id); };

    await expect(fx.uc.execute({ id: s.id, nasId: fx.nasRadiusB.id }, { actorName: 'operador' }))
      .rejects.toBeInstanceOf(PppoeServiceNotFoundError);

    // La lápida NO resucitó: cero filas (upsertByUsername la habría re-INSERTADO).
    expect(await fx.pppoeRepo.list()).toHaveLength(0);
    expect(await fx.pppoeRepo.findByUsername('moveuser')).toBeNull();
  });
});

describe('MovePppoeToNas — S1.8: fallo de DB DESPUÉS del write RADIUS (failed_db)', () => {
  it('update de DB falla post-changeFramedIp → evento failed_db (reason db_update_failed_after_radius_write) + propaga', async () => {
    const pppoeRepo = new DbDownRepo();
    const fx = await buildFixture({ pppoeRepo });
    const s = await seedService(fx);
    pppoeRepo.failWrites = true; // armar DESPUÉS del seeding

    await expect(fx.uc.execute({ id: s.id, nasId: fx.nasRadiusB.id }, { actorName: 'operador' }))
      .rejects.toThrow('db down (post-RADIUS)');

    // El RADIUS SÍ quedó escrito (la divergencia existe y necesita rastro).
    const radiusWrite = fx.orchestrator.calls.find(c => c.op === 'changeFramedIp' && c.username === 'moveuser');
    expect(radiusWrite).toBeDefined();
    expect((radiusWrite!.arg as { framedIp: string }).framedIp).toBe('100.64.43.3');
    // El rastro VISIBLE de la divergencia RADIUS↔DB.
    const events = fx.moveEvents.all();
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe('failed_db');
    expect(events[0].reason).toBe('db_update_failed_after_radius_write');
    expect(events[0].toIp).toBe('100.64.43.3');
  });
});

describe('MovePppoeToNas — REQ-LOG-1 ampliado (fix wave 1, ajuste 5)', () => {
  it('OrchestratorUnreachableError DENTRO de FindFreeIp (listAssignedIps) → evento failed_orchestrator reason=list_assigned_ips', async () => {
    const orchestrator = new InMemoryRadiusOrchestratorGateway({ assignedIpsUnreachable: true });
    const fx = await buildFixture({ orchestrator });
    const s = await seedService(fx);

    await expect(fx.uc.execute({ id: s.id, nasId: fx.nasRadiusB.id }, { actorName: 'operador' }))
      .rejects.toBeInstanceOf(OrchestratorUnreachableError);

    // Nada se escribió (el fallo fue ANTES de elegir IP)…
    expect(fx.orchestrator.calls.filter(c => c.op === 'changeFramedIp')).toHaveLength(0);
    const row = await fx.pppoeRepo.findById(s.id);
    expect(row!.nasId).toBe(NAS_RADIUS_A);
    // …pero el intento quedó VISIBLE en la auditoría.
    const events = fx.moveEvents.all();
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe('failed_orchestrator');
    expect(events[0].reason).toBe('list_assigned_ips');
  });

  it('fallo del move LEGACY (router caído) → evento failed_router + propaga, DB intacta', async () => {
    const routerGw = new InMemoryRouterGateway({ unreachable: ['10.0.0.99'] });
    const fx = await buildFixture({ routerGw });
    const destinoMk = await fx.nasRepo.createNasServer({
      name: 'MK destino caído',
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
      description: 'destino legacy caído',
    });
    const s = await seedService(fx, { username: 'mklegacy', nasId: NAS_MK, remoteAddress: '192.168.1.50' });

    await expect(fx.uc.execute({ id: s.id, nasId: destinoMk.id }, { actorName: 'operador' }))
      .rejects.toBeInstanceOf(RouterUnreachableError);

    const events = fx.moveEvents.all();
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe('failed_router');
    const row = await fx.pppoeRepo.findById(s.id);
    expect(row!.nasId).toBe(NAS_MK);
    expect(row!.remoteAddress).toBe('192.168.1.50');
  });
});

describe('MovePppoeToNas — actorName vacío se normaliza a null (fix wave 1, ajuste 8b)', () => {
  it("manual con actorName '' → PppoeNasMoveEvent.actorName null (no string vacío)", async () => {
    const fx = await buildFixture();
    const s = await seedService(fx);

    await fx.uc.execute({ id: s.id, nasId: fx.nasRadiusB.id }, { actorName: '' });

    const events = fx.moveEvents.all();
    expect(events).toHaveLength(1);
    expect(events[0].actorName).toBeNull();
  });

  it("auto con actorName '' → PppoeNasMoveEvent.actorName 'sistema' (el fallback SÍ aplica)", async () => {
    const fx = await buildFixture();
    const s = await seedService(fx);

    await fx.uc.execute({ id: s.id, nasId: fx.nasRadiusB.id, trigger: 'auto' }, { actorName: '' });

    const events = fx.moveEvents.all();
    expect(events).toHaveLength(1);
    expect(events[0].actorName).toBe('sistema');
  });
});
