/**
 * pppoe-management — CreatePppoeService.
 * Verifica la consistencia DB↔router: alta OK (enabled + secret), router caído (pending + error),
 * username duplicado (no toca el router), nas inexistente.
 */
import { CreatePppoeService } from '@application/use-cases/CreatePppoeService';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryRouterGateway } from '@infrastructure/adapters/in-memory/InMemoryRouterGateway';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { PppoeUsernameTakenError, RouterUnreachableError, NasNotFoundError } from '@domain/errors/pppoe';

// nasId '1' del seed in-memory → ipAddress 192.168.1.1, apiPort 8728
const NAS1 = { ipAddress: '192.168.1.1', apiPort: 8728 };

describe('CreatePppoeService', () => {
  let repo: InMemoryPppoeServiceRepository;
  let router: InMemoryRouterGateway;
  let nasRepo: InMemoryNasRepository;
  let uc: CreatePppoeService;

  beforeEach(() => {
    repo = new InMemoryPppoeServiceRepository();
    router = new InMemoryRouterGateway();
    nasRepo = new InMemoryNasRepository();
    uc = new CreatePppoeService(repo, router, nasRepo);
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
    uc = new CreatePppoeService(repo, router, nasRepo);
    await expect(uc.execute({ contractId: 'C1', username: 'juanperez', password: 'p', nasId: '1' }))
      .rejects.toBeInstanceOf(RouterUnreachableError);
    const row = await repo.findByUsername('juanperez');
    expect(row).not.toBeNull();
    expect(row!.status).toBe('pending');
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
