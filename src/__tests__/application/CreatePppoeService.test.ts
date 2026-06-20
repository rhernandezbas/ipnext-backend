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

// nasId '1' del seed in-memory → ipAddress 192.168.1.1, apiPort 8728 (mikrotik_api → router directo)
const NAS1 = { ipAddress: '192.168.1.1', apiPort: 8728 };
// nasId '3' del seed in-memory → type 'mikrotik_radius' → RADIUS vía orchestrator

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
    uc = new CreatePppoeService(repo, router, nasRepo, orchestrator);
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
    uc = new CreatePppoeService(repo, router, nasRepo, orchestrator);
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

  it('mikrotik_radius: crea el user en el RADIUS (orchestrator.createUser) y NO toca el router', async () => {
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

  it('mikrotik_radius sin remoteAddress: framedIp null (IP del pool)', async () => {
    await uc.execute({ contractId: 'C1', username: 'juanperez', password: 'pass1234', profile: 'IP-Air-30-10', nasId: '3' });
    expect(orchestrator.createdUser('juanperez')!.framedIp).toBeNull();
  });

  it('mikrotik_radius orchestrator caído: la fila queda pending + error propaga', async () => {
    orchestrator = new InMemoryRadiusOrchestratorGateway({ unreachable: ['juanperez'] });
    uc = new CreatePppoeService(repo, router, nasRepo, orchestrator);
    await expect(uc.execute({ contractId: 'C1', username: 'juanperez', password: 'p', profile: 'IP-Air-30-10', nasId: '3' }))
      .rejects.toThrow();
    const row = await repo.findByUsername('juanperez');
    expect(row).not.toBeNull();
    expect(row!.status).toBe('pending');
  });

  it('mikrotik_radius sin profile: PppoeProfileRequiredError (un user RADIUS necesita plan/grupo)', async () => {
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
