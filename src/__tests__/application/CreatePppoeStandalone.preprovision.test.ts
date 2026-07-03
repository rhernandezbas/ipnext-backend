/**
 * pppoe-preprovision-autoinstall — CreatePppoeStandalone (tasks 1.2, spec REQ-PRE-1/REQ-PRE-2).
 *
 * POST /api/pppoe (standalone) también acepta nasId ausente/null = pre-provisión:
 *   - sin contrato: huérfano pendiente de instalación (nasId null, framedIp null en RADIUS).
 *   - con contrato: delega a CreatePppoeService (Guard #4 + activación) con nasId null.
 *   - ipTypePreference se persiste en ambos caminos (default 'cgnat' para callers legacy).
 *   - con NAS radius sin pool-mode y sin framedIp → FindFreeIp(nas, ipTypePreference) (S1.4).
 */
import { CreatePppoeStandalone } from '@application/use-cases/CreatePppoeStandalone';
import { CreatePppoeService } from '@application/use-cases/CreatePppoeService';
import { FindFreeIp } from '@application/use-cases/FindFreeIp';
import { EnsureInternetContractService } from '@application/use-cases/EnsureInternetContractService';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRouterGateway } from '@infrastructure/adapters/in-memory/InMemoryRouterGateway';
import { InMemoryIpNetworkRepository } from '@infrastructure/adapters/in-memory/InMemoryIpNetworkRepository';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { OrchestratorUnreachableError } from '@domain/errors/pppoe';
import type { NasServer } from '@domain/entities/nas';

interface Fixture {
  pppoeRepo: InMemoryPppoeServiceRepository;
  orchestrator: InMemoryRadiusOrchestratorGateway;
  nasRepo: InMemoryNasRepository;
  nasSinPool: NasServer;
  useCase: CreatePppoeStandalone;
}

async function buildFixture(orchOpts?: ConstructorParameters<typeof InMemoryRadiusOrchestratorGateway>[0]): Promise<Fixture> {
  const pppoeRepo = new InMemoryPppoeServiceRepository();
  const orchestrator = new InMemoryRadiusOrchestratorGateway({
    assignedIps: ['100.64.43.2'],
    ...orchOpts,
  });
  const nasRepo = new InMemoryNasRepository();
  const router = new InMemoryRouterGateway();
  const netRepo = new InMemoryIpNetworkRepository();
  const catalogRepo = new InMemoryServiceCatalogRepository();
  await catalogRepo.create({ name: 'INTERNET', label: 'Internet', sortOrder: 0 });
  const ensure = new EnsureInternetContractService(new InMemoryContractServiceRepository(), catalogRepo);

  const nasSinPool = await nasRepo.createNasServer({
    name: 'NAS Radius sin pool-mode', type: 'radius_orchestrator', ipAddress: '10.0.0.9',
    radiusSecret: 'x', nasIpAddress: '10.0.0.9', apiPort: null, apiLogin: null,
    apiPassword: null, status: 'active', lastSeen: null, clientCount: 0, description: '',
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

  const findFreeIp = new FindFreeIp(netRepo, nasRepo, router, orchestrator);
  const delegate = new CreatePppoeService(
    pppoeRepo, router, nasRepo, orchestrator, ensure, undefined, undefined, findFreeIp,
  );
  const useCase = new CreatePppoeStandalone(pppoeRepo, orchestrator, nasRepo, router, delegate, findFreeIp);
  return { pppoeRepo, orchestrator, nasRepo, nasSinPool, useCase };
}

describe('CreatePppoeStandalone — pre-provisión sin NAS (REQ-PRE-1)', () => {
  it('sin nasId y sin contrato → createUser framedIp null; espejo {nasId:null, remoteAddress:null, ipMode:fixed, ipTypePreference}', async () => {
    const fx = await buildFixture();

    const s = await fx.useCase.execute({
      username: 'preprov-orfano',
      password: 'p',
      plan: 'IP-10-5',
      nasId: null,
      ipTypePreference: 'public',
    });

    expect(fx.orchestrator.createdUser('preprov-orfano')).toEqual({
      username: 'preprov-orfano', password: 'p', plan: 'IP-10-5', framedIp: null,
    });
    expect(s.nasId).toBeNull();
    expect(s.remoteAddress).toBeNull();
    expect(s.ipMode).toBe('fixed');
    expect(s.ipTypePreference).toBe('public');
    expect(s.contractId).toBeNull();
    expect(s.status).toBe('enabled');
  });

  it('sin nasId CON contrato → delega a CreatePppoeService (fila con contractId y nasId null)', async () => {
    const fx = await buildFixture();

    const s = await fx.useCase.execute({
      username: 'preprov-ct',
      password: 'p',
      plan: 'IP-10-5',
      nasId: null,
      contractId: 'ct-pre',
      ipTypePreference: 'cgnat',
    });

    expect(s.contractId).toBe('ct-pre');
    expect(s.nasId).toBeNull();
    expect(s.ipTypePreference).toBe('cgnat');
    expect(fx.orchestrator.createdUser('preprov-ct')!.framedIp).toBeNull();
  });

  it('sin nasId + orchestrator caído → NO se inserta fila (sin fantasmas)', async () => {
    const fx = await buildFixture({ unreachable: ['prefail'] });

    await expect(fx.useCase.execute({
      username: 'prefail', password: 'p', plan: 'P1', nasId: null, ipTypePreference: 'cgnat',
    })).rejects.toBeInstanceOf(OrchestratorUnreachableError);

    expect(await fx.pppoeRepo.findByUsername('prefail')).toBeNull();
  });
});

describe('CreatePppoeStandalone — ipTypePreference con NAS (S1.4 / REQ-PRE-2)', () => {
  it('NAS radius sin pool-mode y SIN framedIp → FindFreeIp asigna IP fija del tipo elegido', async () => {
    const fx = await buildFixture(); // .43.2 tomada → primera libre .43.3

    const s = await fx.useCase.execute({
      username: 'standalone-alloc',
      password: 'p',
      plan: 'IP-10-5',
      nasId: fx.nasSinPool.id,
      ipTypePreference: 'cgnat',
    });

    expect(s.remoteAddress).toBe('100.64.43.3');
    expect(s.ipMode).toBe('fixed');
    expect(fx.orchestrator.createdUser('standalone-alloc')!.framedIp).toBe('100.64.43.3');
  });

  it('framedIp explícito sigue intacto y la preferencia se persiste', async () => {
    const fx = await buildFixture();

    const s = await fx.useCase.execute({
      username: 'standalone-fija',
      password: 'p',
      plan: 'IP-10-5',
      nasId: fx.nasSinPool.id,
      framedIp: '100.64.43.90',
      ipTypePreference: 'public',
    });

    expect(s.remoteAddress).toBe('100.64.43.90');
    expect(s.ipTypePreference).toBe('public');
  });
});
