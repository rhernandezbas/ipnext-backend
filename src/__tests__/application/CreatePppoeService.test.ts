/**
 * pppoe-management — CreatePppoeService.
 * Verifica la consistencia DB↔router: alta OK (enabled + secret), router caído (pending + error),
 * username duplicado (no toca el router), nas inexistente.
 */
import { CreatePppoeService } from '@application/use-cases/CreatePppoeService';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryRouterGateway } from '@infrastructure/adapters/in-memory/InMemoryRouterGateway';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { PppoeUsernameTakenError, RouterUnreachableError, NasNotFoundError, PppoeProfileRequiredError } from '@domain/errors/pppoe';
import { EnsureInternetContractService } from '@application/use-cases/EnsureInternetContractService';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';

// nasId '1' del seed in-memory → ipAddress 192.168.1.1, apiPort 8728 (mikrotik_api → router directo)
const NAS1 = { ipAddress: '192.168.1.1', apiPort: 8728 };
// nasId '3' del seed in-memory → type 'radius_orchestrator' → RADIUS vía orchestrator

describe('CreatePppoeService', () => {
  let repo: InMemoryPppoeServiceRepository;
  let router: InMemoryRouterGateway;
  let nasRepo: InMemoryNasRepository;
  let orchestrator: InMemoryRadiusOrchestratorGateway;
  let uc: CreatePppoeService;

  beforeEach(() => {
    repo = new InMemoryPppoeServiceRepository();
    router = new InMemoryRouterGateway();
    nasRepo = new InMemoryNasRepository();
    orchestrator = new InMemoryRadiusOrchestratorGateway();
    const ensure = new EnsureInternetContractService(new InMemoryContractServiceRepository(), new InMemoryServiceCatalogRepository());
    uc = new CreatePppoeService(repo, router, nasRepo, orchestrator, ensure);
  });

  it('alta exitosa: PppoeService enabled + secret en el router', async () => {
    const s = await uc.execute({ contractId: 'C1', username: 'juanperez', password: 'pass1234', profile: 'IP-Air-30-10', nasId: '1' });
    expect(s.status).toBe('enabled');
    expect(s.contractId).toBe('C1');
    expect(s.nasId).toBe('1');
    const secrets = await router.listSecrets(NAS1);
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.username).toBe('juanperez');
    expect(secrets[0]!.profile).toBe('IP-Air-30-10');
  });

  it('router caído: la fila queda pending + RouterUnreachableError (sin "OK" mentiroso)', async () => {
    router = new InMemoryRouterGateway({ unreachable: ['192.168.1.1'] });
    const ensure = new EnsureInternetContractService(new InMemoryContractServiceRepository(), new InMemoryServiceCatalogRepository());
    uc = new CreatePppoeService(repo, router, nasRepo, orchestrator, ensure);
    await expect(uc.execute({ contractId: 'C1', username: 'juanperez', password: 'p', nasId: '1' }))
      .rejects.toBeInstanceOf(RouterUnreachableError);
    const row = await repo.findByUsername('juanperez');
    expect(row).not.toBeNull();
    expect(row!.status).toBe('pending');
  });

  it('mikrotik_api: NO llama al orchestrator (sólo router.createSecret)', async () => {
    await uc.execute({ contractId: 'C1', username: 'juanperez', password: 'pass1234', profile: 'IP-Air-30-10', nasId: '1' });
    expect(orchestrator.opsForCreate('juanperez')).toHaveLength(0);
    expect(await router.listSecrets(NAS1)).toHaveLength(1);
  });

  it('radius_orchestrator: crea el user en el RADIUS (orchestrator.createUser) y NO toca el router', async () => {
    const s = await uc.execute({
      contractId: 'C1',
      username: 'juanperez',
      password: 'pass1234',
      profile: 'IP-Air-30-10',
      remoteAddress: '100.64.10.10',
      nasId: '3',
    });
    expect(s.status).toBe('enabled');
    expect(orchestrator.createdUser('juanperez')).toEqual({
      username: 'juanperez',
      password: 'pass1234',
      plan: 'IP-Air-30-10',
      framedIp: '100.64.10.10',
    });
    // No tocó el router (sucursal RADIUS: ip 10.0.0.5, apiPort null → 8728)
    expect(await router.listSecrets({ ipAddress: '10.0.0.5', apiPort: 8728 })).toHaveLength(0);
  });

  it('radius_orchestrator sin remoteAddress: framedIp null (IP del pool)', async () => {
    await uc.execute({ contractId: 'C1', username: 'juanperez', password: 'pass1234', profile: 'IP-Air-30-10', nasId: '3' });
    expect(orchestrator.createdUser('juanperez')!.framedIp).toBeNull();
  });

  it('radius_orchestrator orchestrator caído: la fila queda pending + error propaga', async () => {
    orchestrator = new InMemoryRadiusOrchestratorGateway({ unreachable: ['juanperez'] });
    const ensure2 = new EnsureInternetContractService(new InMemoryContractServiceRepository(), new InMemoryServiceCatalogRepository());
    uc = new CreatePppoeService(repo, router, nasRepo, orchestrator, ensure2);
    await expect(uc.execute({ contractId: 'C1', username: 'juanperez', password: 'p', profile: 'IP-Air-30-10', nasId: '3' }))
      .rejects.toThrow();
    const row = await repo.findByUsername('juanperez');
    expect(row).not.toBeNull();
    expect(row!.status).toBe('pending');
  });

  it('radius_orchestrator sin profile: PppoeProfileRequiredError (un user RADIUS necesita plan/grupo)', async () => {
    await expect(uc.execute({ contractId: 'C1', username: 'juanperez', password: 'p', nasId: '3' }))
      .rejects.toBeInstanceOf(PppoeProfileRequiredError);
    expect(orchestrator.opsForCreate('juanperez')).toHaveLength(0);
  });

  it('username duplicado: PppoeUsernameTakenError y NO toca el router', async () => {
    await repo.upsertByUsername({ username: 'juanperez', password: 'p', nasId: '1', status: 'enabled' });
    await expect(uc.execute({ contractId: 'C1', username: 'juanperez', password: 'p', nasId: '1' }))
      .rejects.toBeInstanceOf(PppoeUsernameTakenError);
    expect(await router.listSecrets(NAS1)).toHaveLength(0);
  });

  it('nas inexistente: NasNotFoundError', async () => {
    await expect(uc.execute({ contractId: 'C1', username: 'x', password: 'p', nasId: '999' }))
      .rejects.toBeInstanceOf(NasNotFoundError);
  });
});

// ── sqlippool-cleanup: toda creación persiste ipMode='fixed' (el modo pool fue descartado) ──
describe('CreatePppoeService — ipMode siempre fixed (REQ-DEL-3)', () => {
  let repo: InMemoryPppoeServiceRepository;
  let router: InMemoryRouterGateway;
  let nasRepo: InMemoryNasRepository;
  let orchestrator: InMemoryRadiusOrchestratorGateway;
  let uc: CreatePppoeService;

  beforeEach(() => {
    repo = new InMemoryPppoeServiceRepository();
    router = new InMemoryRouterGateway();
    nasRepo = new InMemoryNasRepository();
    orchestrator = new InMemoryRadiusOrchestratorGateway();
    const ensure = new EnsureInternetContractService(new InMemoryContractServiceRepository(), new InMemoryServiceCatalogRepository());
    uc = new CreatePppoeService(repo, router, nasRepo, orchestrator, ensure);
  });

  it('S3.1: NAS radius + remoteAddress explícito → ipMode=fixed, framedIp=la IP', async () => {
    const s = await uc.execute({
      contractId: 'C1',
      username: 'fixeduser',
      password: 'p',
      profile: 'PLAN-10M',
      nasId: '3',
      remoteAddress: '100.64.10.5',
    });
    expect(s.ipMode).toBe('fixed');
    expect(s.remoteAddress).toBe('100.64.10.5');
    expect(orchestrator.createdUser('fixeduser')!.framedIp).toBe('100.64.10.5');
  });

  it('S3.1: NAS legacy (mikrotik_api) → ipMode=fixed (alta fija intacta)', async () => {
    const s = await uc.execute({
      contractId: 'C1',
      username: 'mkuser',
      password: 'p',
      profile: 'IP-Air-30-10',
      nasId: '1',
    });
    expect(s.ipMode).toBe('fixed');
  });

  it("S3.3: crear con ipTypePreference='public' en un NAS radius NO tira PPPOE_PUBLIC_IP_POOL_MODE (guard removido) → ipMode=fixed", async () => {
    // Sin findFreeIp wired la IP queda null (framedIp null), pero el alta NO se rechaza:
    // el guard PppoePublicIpPoolModeError se fue con el modo pool descartado.
    const s = await uc.execute({
      contractId: 'C1',
      username: 'pubuser',
      password: 'p',
      profile: 'IP-PUB-50',
      nasId: '3',
      ipTypePreference: 'public',
    });
    expect(s.ipMode).toBe('fixed');
    expect(s.ipTypePreference).toBe('public');
    expect(orchestrator.createdUser('pubuser')).toBeDefined();
  });
});
