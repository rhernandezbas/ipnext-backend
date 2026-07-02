/**
 * pppoe-preprovision-autoinstall — MovePppoeToNas con origen NULL = ADOPCIÓN (tasks 1.3,
 * spec REQ-PRE-4 S4.3 + soporte core de REQ-PRE-3).
 *
 * Un servicio pendiente de instalación (nasId null, remoteAddress null) movido a un NAS real:
 *   - pasa SIN force (no hay IP actual que perder — guard de pública por remoteAddress null),
 *   - la IP sale del pool del ipTypePreference PERSISTIDO (no siempre cgnat),
 *   - el evento se registra con fromNas null,
 *   - preferencia 'public' en NAS sin pool público → NoPoolForNasTypeError + failed_no_free_ip,
 *     servicio intacto (sigue pendiente),
 *   - regresión: un move NORMAL (con NAS origen) sigue asignando SIEMPRE cgnat aunque la
 *     preferencia persistida sea 'public' (semántica W1 intacta).
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
import { NoPoolForNasTypeError } from '@domain/errors/network';
import type { NasServer } from '@domain/entities/nas';

interface Fixture {
  pppoeRepo: InMemoryPppoeServiceRepository;
  nasRepo: InMemoryNasRepository;
  orchestrator: InMemoryRadiusOrchestratorGateway;
  netRepo: InMemoryIpNetworkRepository;
  moveEvents: InMemoryPppoeNasMoveEventRepository;
  /** NAS destino radius con pool cgnat 100.64.43.0/24 Y pool public 190.15.242.0/24. */
  nasB: NasServer;
  /** NAS destino radius SOLO con pool cgnat (sin público). */
  nasSoloCgnat: NasServer;
  uc: MovePppoeToNas;
}

async function buildFixture(): Promise<Fixture> {
  const pppoeRepo = new InMemoryPppoeServiceRepository();
  const nasRepo   = new InMemoryNasRepository();
  const routerGw  = new InMemoryRouterGateway();
  const netRepo   = new InMemoryIpNetworkRepository();
  const moveEvents = new InMemoryPppoeNasMoveEventRepository();
  const eventRepo  = new InMemoryContractServiceEventRepository();
  const catalogRepo = new InMemoryServiceCatalogRepository();
  await catalogRepo.create({ name: 'INTERNET' });
  const orchestrator = new InMemoryRadiusOrchestratorGateway({
    assignedIps: ['100.64.43.2', '190.15.242.2'],
  });

  const mkNas = (name: string, ip: string) => nasRepo.createNasServer({
    name, type: 'radius_orchestrator', ipAddress: ip, radiusSecret: 'x', nasIpAddress: ip,
    apiPort: null, apiLogin: null, apiPassword: null, status: 'active', lastSeen: null,
    clientCount: 0, description: '',
  });
  const nasB = await mkNas('NAS Radius B', '10.0.0.6');
  const nasSoloCgnat = await mkNas('NAS solo cgnat', '10.0.0.7');

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
  // pool cgnat del NAS solo-cgnat (mismo /24 compartido — alcanza con el vínculo nasId).
  netRepo.seedPool({
    id: 'pool-c-cg', name: 'cgnat-c', networkId: 'net-b',
    rangeStart: '100.64.43.2', rangeEnd: '100.64.43.254',
    type: 'static', assignedCount: null, totalCount: 253, nasId: nasSoloCgnat.id, ipKind: 'cgnat',
  });

  const findFreeIp = new FindFreeIp(netRepo, nasRepo, routerGw, orchestrator);
  const legacyMove = new MovePppoeServiceToRouter(pppoeRepo, routerGw, nasRepo);
  const uc = new MovePppoeToNas(
    pppoeRepo, nasRepo, orchestrator, findFreeIp, legacyMove, moveEvents, catalogRepo, eventRepo, netRepo,
  );

  return { pppoeRepo, nasRepo, orchestrator, netRepo, moveEvents, nasB, nasSoloCgnat, uc };
}

/** Siembra un PENDIENTE de instalación: nasId null, sin IP, con su preferencia persistida. */
async function seedPending(fx: Fixture, ipTypePreference: 'cgnat' | 'public', username = 'pendiente') {
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

describe('MovePppoeToNas — adopción manual de un pendiente (S4.3)', () => {
  it('pendiente cgnat → adopta SIN force: nasId destino + IP del pool cgnat + kick + evento con fromNas null', async () => {
    const fx = await buildFixture();
    const s = await seedPending(fx, 'cgnat');

    const moved = await fx.uc.execute(
      { id: s.id, nasId: fx.nasB.id },
      { actorId: 'op-1', actorName: 'operador' },
    );

    expect(moved.nasId).toBe(fx.nasB.id);
    expect(moved.remoteAddress).toBe('100.64.43.3'); // .2 tomada → primera libre
    expect(moved.ipMode).toBe('fixed');

    // Kick best-effort ejecutado (re-auth con la IP definitiva).
    expect(fx.orchestrator.calls.some(c => c.op === 'disconnectSessions' && c.username === 'pendiente')).toBe(true);

    // Evento con fromNas NULL (no había NAS origen) — adopción visible en el tab.
    const events = fx.moveEvents.all();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      username: 'pendiente',
      fromNasId: null,
      toNasId: fx.nasB.id,
      fromIp: null,
      toIp: '100.64.43.3',
      trigger: 'manual',
      outcome: 'moved',
      actorName: 'operador',
    });
  });

  it("pendiente 'public' → la IP sale del pool PÚBLICO del destino (la preferencia manda el pool)", async () => {
    const fx = await buildFixture();
    const s = await seedPending(fx, 'public');

    const moved = await fx.uc.execute({ id: s.id, nasId: fx.nasB.id });

    expect(moved.remoteAddress).toBe('190.15.242.3'); // .2 tomada → primera libre del pool public
    expect(moved.nasId).toBe(fx.nasB.id);
  });

  it("pendiente 'public' hacia NAS SIN pool público → NoPoolForNasTypeError + evento failed_no_free_ip, sigue pendiente", async () => {
    const fx = await buildFixture();
    const s = await seedPending(fx, 'public');

    await expect(fx.uc.execute({ id: s.id, nasId: fx.nasSoloCgnat.id }))
      .rejects.toBeInstanceOf(NoPoolForNasTypeError);

    // Rastro VISIBLE del fallo + servicio intacto (sigue pendiente de instalación).
    const events = fx.moveEvents.all();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      username: 'pendiente',
      outcome: 'failed_no_free_ip',
      toNasId: fx.nasSoloCgnat.id,
      fromNasId: null,
    });
    const row = await fx.pppoeRepo.findById(s.id);
    expect(row!.nasId).toBeNull();
    expect(row!.remoteAddress).toBeNull();
  });

  it("regresión W1: move NORMAL (con origen) sigue asignando cgnat aunque la preferencia persistida sea 'public'", async () => {
    const fx = await buildFixture();
    // Servicio YA instalado en nasSoloCgnat con preferencia 'public' persistida (p.ej. backfill).
    // Pool cgnat del origen cubre su IP → pasa el guard sin force.
    const s = await fx.pppoeRepo.upsertByUsername({
      username: 'instalado',
      password: 'secret',
      profile: 'IP-PUB-50',
      remoteAddress: '100.64.43.50',
      status: 'enabled',
      nasId: fx.nasSoloCgnat.id,
      contractId: null,
      ipMode: 'fixed',
      ipTypePreference: 'public',
    });

    const moved = await fx.uc.execute({ id: s.id, nasId: fx.nasB.id });

    // Semántica W1 intacta: el move manual asigna del pool CGNAT del destino (no del público).
    expect(moved.remoteAddress).toBe('100.64.43.3');
  });
});
