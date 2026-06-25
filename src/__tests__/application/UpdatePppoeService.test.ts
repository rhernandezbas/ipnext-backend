/**
 * pppoe-management — UpdatePppoeService.
 * Verifica el RUTEO por `nas.type`:
 *   - radius_orchestrator → cada campo provisto va a la llamada del orchestrator correcta
 *     (profile→changePlan, password→changePassword, remoteAddress→changeFramedIp,
 *      status→suspend/reactivate). NUNCA toca el router (RouterOS 7.x cuelga).
 *   - mikrotik_api → router.updateSecret (como siempre).
 * En ambos casos confirma el upsert en la DB.
 */
import { UpdatePppoeService } from '@application/use-cases/UpdatePppoeService';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryRouterGateway } from '@infrastructure/adapters/in-memory/InMemoryRouterGateway';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { PppoeServiceNotFoundError, NasNotFoundError } from '@domain/errors/pppoe';

// nasId '1' del seed in-memory → 192.168.1.1, mikrotik_api (router directo)
const NAS1 = { ipAddress: '192.168.1.1', apiPort: 8728 };
// nasId '3' del seed in-memory → type 'radius_orchestrator' → orchestrator
const NAS3 = { ipAddress: '10.0.0.5', apiPort: 8728 };

describe('UpdatePppoeService', () => {
  let repo: InMemoryPppoeServiceRepository;
  let router: InMemoryRouterGateway;
  let nasRepo: InMemoryNasRepository;
  let orchestrator: InMemoryRadiusOrchestratorGateway;
  let uc: UpdatePppoeService;

  beforeEach(() => {
    repo = new InMemoryPppoeServiceRepository();
    router = new InMemoryRouterGateway();
    nasRepo = new InMemoryNasRepository();
    orchestrator = new InMemoryRadiusOrchestratorGateway();
    uc = new UpdatePppoeService(repo, router, nasRepo, orchestrator);
  });

  async function seedRadius(): Promise<string> {
    const row = await repo.upsertByUsername({
      username: 'juanperez',
      password: 'oldpass',
      profile: 'IP-Air-30-10',
      remoteAddress: '100.64.10.10',
      nasId: '3',
      status: 'enabled',
    });
    return row.id;
  }

  async function seedApi(): Promise<string> {
    await router.createSecret(NAS1, {
      username: 'juanperez',
      password: 'oldpass',
      profile: 'IP-Air-30-10',
      remoteAddress: '100.64.10.10',
    });
    const row = await repo.upsertByUsername({
      username: 'juanperez',
      password: 'oldpass',
      profile: 'IP-Air-30-10',
      remoteAddress: '100.64.10.10',
      nasId: '1',
      status: 'enabled',
    });
    return row.id;
  }

  // ── radius_orchestrator: rutea CADA campo a la llamada del orchestrator correcta ──
  it('radius_orchestrator: profile → orchestrator.changePlan y NO toca el router', async () => {
    const id = await seedRadius();
    await uc.execute({ id, profile: 'IP-REDUCCION' });
    expect(orchestrator.opsFor('juanperez')).toEqual(['changePlan']);
    expect(orchestrator.planOf('juanperez')).toBe('IP-REDUCCION');
    const secrets = await router.listSecrets(NAS3);
    expect(secrets).toHaveLength(0);
  });

  it('radius_orchestrator: password → orchestrator.changePassword', async () => {
    const id = await seedRadius();
    await uc.execute({ id, password: 'nuevaPass123' });
    expect(orchestrator.opsFor('juanperez')).toEqual(['changePassword']);
    expect(orchestrator.passwordOf('juanperez')).toBe('nuevaPass123');
  });

  it('radius_orchestrator: remoteAddress → orchestrator.changeFramedIp', async () => {
    const id = await seedRadius();
    await uc.execute({ id, remoteAddress: '100.64.10.99' });
    expect(orchestrator.opsFor('juanperez')).toEqual(['changeFramedIp']);
    expect(orchestrator.framedIpOf('juanperez')).toBe('100.64.10.99');
  });

  it('radius_orchestrator: status disabled → orchestrator.suspend', async () => {
    const id = await seedRadius();
    await uc.execute({ id, status: 'disabled' });
    expect(orchestrator.opsFor('juanperez')).toEqual(['suspend']);
    expect(orchestrator.isSuspended('juanperez')).toBe(true);
    const row = await repo.findById(id);
    expect(row!.status).toBe('disabled');
  });

  it('radius_orchestrator: status enabled → orchestrator.reactivate', async () => {
    const id = await seedRadius();
    await uc.execute({ id, status: 'enabled' });
    expect(orchestrator.opsFor('juanperez')).toEqual(['reactivate']);
    expect(orchestrator.isSuspended('juanperez')).toBe(false);
  });

  it('radius_orchestrator: SÓLO los campos provistos se rutean (no toca lo no provisto)', async () => {
    const id = await seedRadius();
    await uc.execute({ id, profile: 'IP-NUEVO', password: 'pw2' });
    expect(orchestrator.opsFor('juanperez').sort()).toEqual(['changePassword', 'changePlan']);
    expect(orchestrator.planOf('juanperez')).toBe('IP-NUEVO');
    expect(orchestrator.passwordOf('juanperez')).toBe('pw2');
  });

  it('radius_orchestrator: confirma el upsert en la DB con los campos editados', async () => {
    const id = await seedRadius();
    const out = await uc.execute({ id, profile: 'IP-REDUCCION', password: 'pw2', remoteAddress: '100.64.10.99' });
    expect(out.profile).toBe('IP-REDUCCION');
    expect(out.password).toBe('pw2');
    expect(out.remoteAddress).toBe('100.64.10.99');
  });

  // ── mikrotik_api: sigue usando el router ──
  it('mikrotik_api: usa router.updateSecret y NO toca el orchestrator', async () => {
    const id = await seedApi();
    await uc.execute({ id, profile: 'IP-REDUCCION', remoteAddress: '100.64.10.99' });
    expect(orchestrator.opsFor('juanperez')).toHaveLength(0);
    const secrets = await router.listSecrets(NAS1);
    expect(secrets[0]!.profile).toBe('IP-REDUCCION');
    expect(secrets[0]!.remoteAddress).toBe('100.64.10.99');
  });

  it('mikrotik_api: status disabled → router secret disabled=true', async () => {
    const id = await seedApi();
    await uc.execute({ id, status: 'disabled' });
    expect(orchestrator.opsFor('juanperez')).toHaveLength(0);
    const secrets = await router.listSecrets(NAS1);
    expect(secrets[0]!.disabled).toBe(true);
  });

  // ── guardas ──
  it('id inexistente: PppoeServiceNotFoundError', async () => {
    await expect(uc.execute({ id: '999', profile: 'X' })).rejects.toBeInstanceOf(PppoeServiceNotFoundError);
  });

  it('nas inexistente: NasNotFoundError', async () => {
    const row = await repo.upsertByUsername({ username: 'x', password: 'p', nasId: '999', status: 'enabled' });
    await expect(uc.execute({ id: row.id, profile: 'X' })).rejects.toBeInstanceOf(NasNotFoundError);
  });
});
