/**
 * pppoe-management — DeactivatePppoeService.
 * Baja SOFT ruteada por `nas.type`:
 *   - mikrotik_radius → orchestrator.suspend (RouterOS 7.x cuelga el API; el RADIUS es la verdad).
 *   - mikrotik_api    → router.updateSecret({disabled:true}) (como siempre).
 * En ambos casos marca status='disabled' en la DB (no borra la fila).
 */
import { DeactivatePppoeService } from '@application/use-cases/DeactivatePppoeService';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryRouterGateway } from '@infrastructure/adapters/in-memory/InMemoryRouterGateway';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { PppoeServiceNotFoundError, NasNotFoundError } from '@domain/errors/pppoe';

const NAS1 = { ipAddress: '192.168.1.1', apiPort: 8728 };
const NAS3 = { ipAddress: '10.0.0.5', apiPort: 8728 };

describe('DeactivatePppoeService', () => {
  let repo: InMemoryPppoeServiceRepository;
  let router: InMemoryRouterGateway;
  let nasRepo: InMemoryNasRepository;
  let orchestrator: InMemoryRadiusOrchestratorGateway;
  let uc: DeactivatePppoeService;

  beforeEach(() => {
    repo = new InMemoryPppoeServiceRepository();
    router = new InMemoryRouterGateway();
    nasRepo = new InMemoryNasRepository();
    orchestrator = new InMemoryRadiusOrchestratorGateway();
    uc = new DeactivatePppoeService(repo, router, nasRepo, orchestrator);
  });

  it('mikrotik_radius: orchestrator.suspend y NO toca el router; DB status=disabled', async () => {
    const row = await repo.upsertByUsername({
      username: 'juanperez', password: 'p', profile: 'IP-Air-30-10', remoteAddress: '100.64.10.10',
      nasId: '3', status: 'enabled',
    });
    const out = await uc.execute(row.id);
    expect(out.status).toBe('disabled');
    expect(orchestrator.opsFor('juanperez')).toEqual(['suspend']);
    expect(orchestrator.isSuspended('juanperez')).toBe(true);
    expect(await router.listSecrets(NAS3)).toHaveLength(0);
  });

  it('mikrotik_api: router.updateSecret({disabled:true}) y NO toca el orchestrator; DB status=disabled', async () => {
    await router.createSecret(NAS1, { username: 'juanperez', password: 'p', profile: 'IP-Air-30-10' });
    const row = await repo.upsertByUsername({
      username: 'juanperez', password: 'p', profile: 'IP-Air-30-10', nasId: '1', status: 'enabled',
    });
    const out = await uc.execute(row.id);
    expect(out.status).toBe('disabled');
    expect(orchestrator.opsFor('juanperez')).toHaveLength(0);
    const secrets = await router.listSecrets(NAS1);
    expect(secrets[0]!.disabled).toBe(true);
  });

  it('id inexistente: PppoeServiceNotFoundError', async () => {
    await expect(uc.execute('999')).rejects.toBeInstanceOf(PppoeServiceNotFoundError);
  });

  it('nas inexistente: NasNotFoundError', async () => {
    const row = await repo.upsertByUsername({ username: 'x', password: 'p', nasId: '999', status: 'enabled' });
    await expect(uc.execute(row.id)).rejects.toBeInstanceOf(NasNotFoundError);
  });
});
