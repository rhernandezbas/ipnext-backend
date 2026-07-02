/**
 * pppoe-preprovision-autoinstall — CreatePppoeService (tasks 1.2, spec REQ-PRE-1/REQ-PRE-2).
 *
 * Matriz:
 *   S1.1 create sin NAS válido → createUser al orchestrator con framedIp null; fila
 *        {nasId:null, remoteAddress:null, ipMode:'fixed', ipTypePreference} enabled.
 *   S1.3 create sin NAS sin plan → PppoeProfileRequiredError (error tipado existente), nada creado.
 *   Guard #4 intacto sin NAS: contrato con PPPoE enabled → PppoeContractAlreadyHasServiceError.
 *   S1.4 flujo CON NAS intacto + ipTypePreference persistido; NAS radius SIN pool-mode y SIN
 *        remoteAddress → FindFreeIp(nas, ipTypePreference) asigna la IP server-side (fixed).
 *   S2.2 ipTypePreference persistido y expuesto en la entidad (default 'cgnat' si el caller no lo manda).
 */
import { CreatePppoeService } from '@application/use-cases/CreatePppoeService';
import { FindFreeIp } from '@application/use-cases/FindFreeIp';
import { EnsureInternetContractService } from '@application/use-cases/EnsureInternetContractService';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryRouterGateway } from '@infrastructure/adapters/in-memory/InMemoryRouterGateway';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { InMemoryIpNetworkRepository } from '@infrastructure/adapters/in-memory/InMemoryIpNetworkRepository';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import {
  PppoeProfileRequiredError,
  PppoeContractAlreadyHasServiceError,
} from '@domain/errors/pppoe';
import { NoPoolForNasTypeError } from '@domain/errors/network';
import type { NasServer } from '@domain/entities/nas';

interface Fixture {
  repo: InMemoryPppoeServiceRepository;
  router: InMemoryRouterGateway;
  nasRepo: InMemoryNasRepository;
  orchestrator: InMemoryRadiusOrchestratorGateway;
  netRepo: InMemoryIpNetworkRepository;
  /** NAS radius SIN poolName y con pools cgnat + public cargados (rama FindFreeIp de S1.4). */
  nasSinPool: NasServer;
  uc: CreatePppoeService;
}

async function buildFixture(opts?: { assignedIps?: string[] }): Promise<Fixture> {
  const repo = new InMemoryPppoeServiceRepository();
  const router = new InMemoryRouterGateway();
  const nasRepo = new InMemoryNasRepository();
  const netRepo = new InMemoryIpNetworkRepository();
  const orchestrator = new InMemoryRadiusOrchestratorGateway({
    assignedIps: opts?.assignedIps ?? ['100.64.43.2', '190.15.242.2'],
  });
  const ensure = new EnsureInternetContractService(
    new InMemoryContractServiceRepository(),
    new InMemoryServiceCatalogRepository(),
  );

  // NAS radius SIN poolName (no pool-mode): el caso donde la creación sin IP explícita antes
  // quedaba 'fixed' con framedIp null — ahora asigna server-side con FindFreeIp (S1.4).
  const nasSinPool = await nasRepo.createNasServer({
    name: 'NAS Radius sin pool-mode',
    type: 'radius_orchestrator',
    ipAddress: '10.0.0.9',
    radiusSecret: 'x',
    nasIpAddress: '10.0.0.9',
    apiPort: null,
    apiLogin: null,
    apiPassword: null,
    status: 'active',
    lastSeen: null,
    clientCount: 0,
    description: 'radius sin poolName',
  });
  netRepo.seedNetwork({
    id: 'net-cg', network: '100.64.43.0/24', gateway: '100.64.43.1', dns1: '8.8.8.8', dns2: '8.8.4.4',
    description: 'CGNAT', partnerId: null, type: 'pppoe', totalIps: 254, usedIps: null, freeIps: null,
  });
  netRepo.seedPool({
    id: 'pool-cg', name: 'cgnat', networkId: 'net-cg',
    rangeStart: '100.64.43.2', rangeEnd: '100.64.43.254',
    type: 'static', assignedCount: null, totalCount: 253, nasId: nasSinPool.id, ipKind: 'cgnat',
  });
  netRepo.seedNetwork({
    id: 'net-pub', network: '190.15.242.0/24', gateway: '190.15.242.1', dns1: '8.8.8.8', dns2: '8.8.4.4',
    description: 'Públicas', partnerId: null, type: 'pppoe', totalIps: 254, usedIps: null, freeIps: null,
  });
  netRepo.seedPool({
    id: 'pool-pub', name: 'publicas', networkId: 'net-pub',
    rangeStart: '190.15.242.2', rangeEnd: '190.15.242.254',
    type: 'static', assignedCount: null, totalCount: 253, nasId: nasSinPool.id, ipKind: 'public',
  });

  const findFreeIp = new FindFreeIp(netRepo, nasRepo, router, orchestrator);
  const uc = new CreatePppoeService(
    repo, router, nasRepo, orchestrator, ensure, undefined, undefined, findFreeIp,
  );
  return { repo, router, nasRepo, orchestrator, netRepo, nasSinPool, uc };
}

describe('CreatePppoeService — pre-provisión sin NAS (REQ-PRE-1, design D3)', () => {
  it('S1.1: nasId null → createUser con framedIp null; fila {nasId:null, remoteAddress:null, ipMode:fixed, ipTypePreference} enabled', async () => {
    const fx = await buildFixture();

    const s = await fx.uc.execute({
      contractId: 'C1',
      username: 'preprov1',
      password: 'secret',
      profile: 'IP-Air-30-10',
      nasId: null,
      ipTypePreference: 'public',
    });

    // Al RADIUS central, SIN Framed-IP (conecta con IP temporal del pool fallback del NAS).
    expect(fx.orchestrator.createdUser('preprov1')).toEqual({
      username: 'preprov1',
      password: 'secret',
      plan: 'IP-Air-30-10',
      framedIp: null,
    });

    // "Pendiente de instalación" = DERIVACIÓN nasId===null; nace enabled (cero status nuevos).
    expect(s.status).toBe('enabled');
    expect(s.nasId).toBeNull();
    expect(s.remoteAddress).toBeNull();
    expect(s.ipMode).toBe('fixed');
    expect(s.ipTypePreference).toBe('public');
    expect(s.contractId).toBe('C1');

    // NO llama FindFreeIp (no hay pool sin NAS) — cero consultas de IPs asignadas.
    expect(fx.orchestrator.calls.filter(c => c.op === 'createUser')).toHaveLength(1);
  });

  it('S1.3: sin plan (profile) → PppoeProfileRequiredError, NADA creado (ni RADIUS ni fila)', async () => {
    const fx = await buildFixture();

    await expect(fx.uc.execute({
      contractId: 'C1',
      username: 'sinplan',
      password: 'p',
      nasId: null,
      ipTypePreference: 'cgnat',
    })).rejects.toBeInstanceOf(PppoeProfileRequiredError);

    expect(fx.orchestrator.createdUser('sinplan')).toBeUndefined();
    expect(await fx.repo.findByUsername('sinplan')).toBeNull();
  });

  it('Guard #4 intacto sin NAS: contrato con PPPoE enabled → PppoeContractAlreadyHasServiceError, nada creado', async () => {
    const fx = await buildFixture();
    await fx.repo.upsertByUsername({
      username: 'existente', password: 'p', profile: 'P1', nasId: '3',
      contractId: 'ct-lleno', status: 'enabled',
    });

    await expect(fx.uc.execute({
      contractId: 'ct-lleno',
      username: 'nuevo-pre',
      password: 'p',
      profile: 'P1',
      nasId: null,
      ipTypePreference: 'cgnat',
    })).rejects.toBeInstanceOf(PppoeContractAlreadyHasServiceError);

    expect(fx.orchestrator.createdUser('nuevo-pre')).toBeUndefined();
    expect(await fx.repo.findByUsername('nuevo-pre')).toBeNull();
  });
});

describe('CreatePppoeService — ipTypePreference en el flujo CON NAS (S1.4 / REQ-PRE-2)', () => {
  it('S1.4: NAS radius sin pool-mode y SIN remoteAddress → FindFreeIp asigna la IP del tipo elegido (public)', async () => {
    const fx = await buildFixture(); // .242.2 tomada → primera libre .242.3 (gateway .1 excluido)

    const s = await fx.uc.execute({
      contractId: 'C1',
      username: 'conip-pub',
      password: 'p',
      profile: 'IP-PUB-50',
      nasId: fx.nasSinPool.id,
      ipTypePreference: 'public',
    });

    expect(s.ipMode).toBe('fixed');
    expect(s.remoteAddress).toBe('190.15.242.3');
    expect(s.ipTypePreference).toBe('public');
    expect(fx.orchestrator.createdUser('conip-pub')!.framedIp).toBe('190.15.242.3');
  });

  it('S1.4: mismo caso con preferencia cgnat → IP del pool cgnat', async () => {
    const fx = await buildFixture(); // .43.2 tomada → primera libre .43.3

    const s = await fx.uc.execute({
      contractId: 'C1',
      username: 'conip-cg',
      password: 'p',
      profile: 'IP-Air-30-10',
      nasId: fx.nasSinPool.id,
      ipTypePreference: 'cgnat',
    });

    expect(s.remoteAddress).toBe('100.64.43.3');
    expect(fx.orchestrator.createdUser('conip-cg')!.framedIp).toBe('100.64.43.3');
  });

  it('S1.4 regresión: remoteAddress EXPLÍCITA sigue intacta (no llama FindFreeIp) y persiste la preferencia', async () => {
    const fx = await buildFixture();

    const s = await fx.uc.execute({
      contractId: 'C1',
      username: 'explicita',
      password: 'p',
      profile: 'IP-Air-30-10',
      nasId: fx.nasSinPool.id,
      remoteAddress: '100.64.43.77',
      ipTypePreference: 'cgnat',
    });

    expect(s.remoteAddress).toBe('100.64.43.77');
    expect(s.ipMode).toBe('fixed');
    expect(s.ipTypePreference).toBe('cgnat');
  });

  it('S1.4 regresión: NAS pool-mode (poolName) sin remoteAddress → rama pool intacta (framedIp null, sin FindFreeIp)', async () => {
    const fx = await buildFixture();

    // NAS '3' del seed: radius_orchestrator CON poolName ('asur-cgnat').
    const s = await fx.uc.execute({
      contractId: 'C1',
      username: 'pooluser',
      password: 'p',
      profile: 'PLAN-10M',
      nasId: '3',
      ipTypePreference: 'cgnat',
    });

    expect(s.ipMode).toBe('pool');
    expect(s.remoteAddress).toBeNull();
    expect(fx.orchestrator.createdUser('pooluser')!.framedIp).toBeNull();
  });

  it("S1.4: preferencia 'public' en NAS sin pool público → NoPoolForNasTypeError ANTES de tocar el RADIUS", async () => {
    const fx = await buildFixture();
    // NAS radius sin pools públicos: creo otro NAS sin seeds de pool public.
    const nasSoloCgnat = await fx.nasRepo.createNasServer({
      name: 'NAS solo cgnat', type: 'radius_orchestrator', ipAddress: '10.0.0.10',
      radiusSecret: 'x', nasIpAddress: '10.0.0.10', apiPort: null, apiLogin: null,
      apiPassword: null, status: 'active', lastSeen: null, clientCount: 0, description: '',
    });
    fx.netRepo.seedPool({
      id: 'pool-cg2', name: 'cgnat2', networkId: 'net-cg',
      rangeStart: '100.64.43.2', rangeEnd: '100.64.43.254',
      type: 'static', assignedCount: null, totalCount: 253, nasId: nasSoloCgnat.id, ipKind: 'cgnat',
    });

    await expect(fx.uc.execute({
      contractId: 'C1',
      username: 'sin-pool-pub',
      password: 'p',
      profile: 'IP-PUB-50',
      nasId: nasSoloCgnat.id,
      ipTypePreference: 'public',
    })).rejects.toBeInstanceOf(NoPoolForNasTypeError);

    expect(fx.orchestrator.createdUser('sin-pool-pub')).toBeUndefined();
  });

  it("S2.2: sin ipTypePreference en el input (caller legacy) → default 'cgnat' persistido", async () => {
    const fx = await buildFixture();

    const s = await fx.uc.execute({
      contractId: 'C1',
      username: 'legacy-caller',
      password: 'p',
      profile: 'IP-Air-30-10',
      nasId: '3',
    });

    expect(s.ipTypePreference).toBe('cgnat');
  });
});
