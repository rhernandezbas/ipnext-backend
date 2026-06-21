/**
 * UpdatePppoeService — pppoe-plan-change-history.
 *
 * TDD: escritos ANTES de la implementación.
 *
 * Escenarios:
 *   1. changePlan llamado con { applyInSession: true } en path mikrotik_radius.
 *   2. Evento 'modified' registrado con reason+actor+notes(old→new) cuando contractId presente
 *      y el profile CAMBIA.
 *   3. Sin evento cuando el profile no cambia.
 *   4. Sin evento cuando no hay contractId.
 *   5. Sin evento cuando no hay catalogRepo/eventRepo (back-compat).
 *   6. Best-effort: eventRepo.record lanza → execute sigue sin lanzar.
 */
import { UpdatePppoeService } from '@application/use-cases/UpdatePppoeService';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryRouterGateway } from '@infrastructure/adapters/in-memory/InMemoryRouterGateway';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';

// nasId '3' from InMemoryNasRepository seed → mikrotik_radius
const RADIUS_NAS_ID = '3';
const CONTRACT_ID = 'C1';

async function seedCatalog(catalogRepo: InMemoryServiceCatalogRepository) {
  return catalogRepo.create({ name: 'INTERNET', label: 'Internet', active: true, sortOrder: 1 });
}

describe('UpdatePppoeService — pppoe-plan-change-history', () => {
  let repo: InMemoryPppoeServiceRepository;
  let router: InMemoryRouterGateway;
  let nasRepo: InMemoryNasRepository;
  let orchestrator: InMemoryRadiusOrchestratorGateway;
  let catalogRepo: InMemoryServiceCatalogRepository;
  let eventRepo: InMemoryContractServiceEventRepository;

  beforeEach(() => {
    repo = new InMemoryPppoeServiceRepository();
    router = new InMemoryRouterGateway();
    nasRepo = new InMemoryNasRepository();
    orchestrator = new InMemoryRadiusOrchestratorGateway();
    catalogRepo = new InMemoryServiceCatalogRepository();
    eventRepo = new InMemoryContractServiceEventRepository();
  });

  async function seedRadiusWithContract(): Promise<string> {
    const row = await repo.upsertByUsername({
      username: 'juanperez',
      password: 'oldpass',
      profile: 'IP-Air-30-10',
      remoteAddress: '100.64.10.10',
      nasId: RADIUS_NAS_ID,
      contractId: CONTRACT_ID,
      status: 'enabled',
    });
    return row.id;
  }

  // ── 1. applyInSession: true ─────────────────────────────────────────────────
  it('changePlan es llamado con { applyInSession: true } en mikrotik_radius', async () => {
    const uc = new UpdatePppoeService(repo, router, nasRepo, orchestrator, catalogRepo, eventRepo);
    const id = await seedRadiusWithContract();
    await seedCatalog(catalogRepo);

    await uc.execute({ id, profile: 'IP-NUEVO', actorId: 'A1', actorName: 'Admin' });

    // Verify the changePlan call had applyInSession: true
    const changePlanCalls = orchestrator.calls.filter(c => c.op === 'changePlan' && c.username === 'juanperez');
    expect(changePlanCalls).toHaveLength(1);
    expect(changePlanCalls[0]!.arg).toEqual({ plan: 'IP-NUEVO', applyInSession: true });
  });

  // ── 2. Evento 'modified' registrado ────────────────────────────────────────
  it('profile cambia + contractId → registra evento modified con reason, actor y notes(old→new)', async () => {
    const uc = new UpdatePppoeService(repo, router, nasRepo, orchestrator, catalogRepo, eventRepo);
    const id = await seedRadiusWithContract();
    await seedCatalog(catalogRepo);

    await uc.execute({
      id,
      profile: 'IP-Air-40-15',
      reason: 'upgrade a pedido del cliente',
      actorId: 'A1',
      actorName: 'Operador1',
    });

    const events = await eventRepo.listByContract(CONTRACT_ID);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('modified');
    expect(events[0]!.reason).toBe('upgrade a pedido del cliente');
    expect(events[0]!.actorId).toBe('A1');
    expect(events[0]!.actorName).toBe('Operador1');
    expect(events[0]!.notes).toBe('IP-Air-30-10 → IP-Air-40-15');
  });

  it('reason=null → evento modified con reason null', async () => {
    const uc = new UpdatePppoeService(repo, router, nasRepo, orchestrator, catalogRepo, eventRepo);
    const id = await seedRadiusWithContract();
    await seedCatalog(catalogRepo);

    await uc.execute({ id, profile: 'IP-Air-40-15', reason: null, actorId: 'A1', actorName: 'Op' });

    const events = await eventRepo.listByContract(CONTRACT_ID);
    expect(events).toHaveLength(1);
    expect(events[0]!.reason).toBeNull();
  });

  it('profile original null → notes "— → IP-Air-40-15"', async () => {
    const row = await repo.upsertByUsername({
      username: 'sinplan',
      password: 'p',
      profile: null,
      nasId: RADIUS_NAS_ID,
      contractId: CONTRACT_ID,
      status: 'enabled',
    });
    const uc = new UpdatePppoeService(repo, router, nasRepo, orchestrator, catalogRepo, eventRepo);
    await seedCatalog(catalogRepo);

    await uc.execute({ id: row.id, profile: 'IP-Air-40-15', actorId: 'A1', actorName: 'Op' });

    const events = await eventRepo.listByContract(CONTRACT_ID);
    expect(events).toHaveLength(1);
    expect(events[0]!.notes).toBe('— → IP-Air-40-15');
  });

  // ── 3. Sin evento cuando el profile no cambia ───────────────────────────────
  it('profile igual al actual → NO se registra evento', async () => {
    const uc = new UpdatePppoeService(repo, router, nasRepo, orchestrator, catalogRepo, eventRepo);
    const id = await seedRadiusWithContract();
    await seedCatalog(catalogRepo);

    // Same profile as in seed: 'IP-Air-30-10'
    await uc.execute({ id, profile: 'IP-Air-30-10', actorId: 'A1', actorName: 'Op' });

    const events = await eventRepo.listByContract(CONTRACT_ID);
    expect(events).toHaveLength(0);
  });

  it('profile no provisto (undefined) → NO se registra evento', async () => {
    const uc = new UpdatePppoeService(repo, router, nasRepo, orchestrator, catalogRepo, eventRepo);
    const id = await seedRadiusWithContract();
    await seedCatalog(catalogRepo);

    await uc.execute({ id, password: 'nueva123', actorId: 'A1', actorName: 'Op' });

    const events = await eventRepo.listByContract(CONTRACT_ID);
    expect(events).toHaveLength(0);
  });

  // ── 4. Sin evento cuando no hay contractId ──────────────────────────────────
  it('sin contractId → NO se registra evento', async () => {
    const row = await repo.upsertByUsername({
      username: 'orfano',
      password: 'p',
      profile: 'IP-Air-30-10',
      nasId: RADIUS_NAS_ID,
      contractId: null,
      status: 'enabled',
    });
    const uc = new UpdatePppoeService(repo, router, nasRepo, orchestrator, catalogRepo, eventRepo);
    await seedCatalog(catalogRepo);

    await uc.execute({ id: row.id, profile: 'IP-Air-40-15', actorId: 'A1', actorName: 'Op' });

    const events = eventRepo.all();
    expect(events).toHaveLength(0);
  });

  // ── 5. Back-compat: sin catalogRepo/eventRepo → no evento, no error ─────────
  it('sin catalogRepo/eventRepo (back-compat) → execute exitoso sin evento', async () => {
    const uc = new UpdatePppoeService(repo, router, nasRepo, orchestrator);
    const id = await seedRadiusWithContract();

    // Should not throw even without catalog/event repos
    const result = await uc.execute({ id, profile: 'IP-Air-40-15' });
    expect(result.profile).toBe('IP-Air-40-15');
  });

  // ── 6. Best-effort: eventRepo.record lanza → execute sigue ─────────────────
  it('eventRepo.record lanza → execute NO relanza (best-effort)', async () => {
    const throwingEventRepo: InMemoryContractServiceEventRepository = {
      record: async () => { throw new Error('DB down'); },
      listByContract: async () => [],
      all: () => [],
    } as unknown as InMemoryContractServiceEventRepository;

    const uc = new UpdatePppoeService(repo, router, nasRepo, orchestrator, catalogRepo, throwingEventRepo);
    const id = await seedRadiusWithContract();
    await seedCatalog(catalogRepo);

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    // Should not throw even if event recording fails
    await expect(uc.execute({ id, profile: 'IP-Air-40-15', actorId: 'A1', actorName: 'Op' })).resolves.toBeDefined();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[UpdatePppoeService]'),
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });
});
