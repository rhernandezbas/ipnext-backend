/**
 * UpdatePppoeService — pppoe-change-audit.
 *
 * TDD: escritos ANTES de la implementación.
 *
 * Problema: editar un PPPoE registraba historial SOLO cuando cambiaba el plan/profile.
 * Un cambio de IP (remoteAddress), password o status pasaba por el path inline legacy y
 * NO escribía evento → trazabilidad perdida. Este feature audita TODOS los cambios al
 * historial del cliente cuando el servicio está asociado a un contrato.
 *
 * Modelo de evento (design LOCKED):
 *   - eventType siempre 'modified'; `changeKind` discrimina:
 *     · null       → cambio de plan (comportamiento EXISTENTE, usa oldPlan/newPlan).
 *     · 'ip'       → oldValue = IP vieja, newValue = IP nueva.
 *     · 'password' → oldValue / newValue = null (SEGURIDAD: nunca se persiste la clave).
 *     · 'status'   → oldValue = status viejo, newValue = status nuevo.
 *
 * nasId '3' del seed in-memory → radius_orchestrator.
 */
import { UpdatePppoeService } from '@application/use-cases/UpdatePppoeService';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryRouterGateway } from '@infrastructure/adapters/in-memory/InMemoryRouterGateway';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';

const RADIUS_NAS_ID = '3';
const CONTRACT_ID = 'C1';

async function seedCatalog(catalogRepo: InMemoryServiceCatalogRepository) {
  return catalogRepo.create({ name: 'INTERNET', label: 'Internet', active: true, sortOrder: 1 });
}

describe('UpdatePppoeService — pppoe-change-audit (IP / password / status)', () => {
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

  async function seedRadiusWithContract(contractId: string | null = CONTRACT_ID): Promise<string> {
    const row = await repo.upsertByUsername({
      username: 'juanperez',
      password: 'oldpass',
      profile: 'IP-Air-30-10',
      remoteAddress: '100.64.10.10',
      nasId: RADIUS_NAS_ID,
      contractId,
      status: 'enabled',
    });
    return row.id;
  }

  // ── IP change ────────────────────────────────────────────────────────────────
  it('cambio de IP (remoteAddress) → 1 evento changeKind ip con old/new IP', async () => {
    const uc = new UpdatePppoeService(repo, router, nasRepo, orchestrator, catalogRepo, eventRepo);
    const id = await seedRadiusWithContract();
    await seedCatalog(catalogRepo);

    await uc.execute({ id, remoteAddress: '100.64.10.99', reason: 'reubicación', actorId: 'A1', actorName: 'Op' });

    const events = await eventRepo.listByContract(CONTRACT_ID);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('modified');
    expect(events[0]!.changeKind).toBe('ip');
    expect(events[0]!.oldValue).toBe('100.64.10.10');
    expect(events[0]!.newValue).toBe('100.64.10.99');
    // reason + actor threaded desde el input.
    expect(events[0]!.reason).toBe('reubicación');
    expect(events[0]!.actorId).toBe('A1');
    expect(events[0]!.actorName).toBe('Op');
    // NO es un evento de plan.
    expect(events[0]!.oldPlan).toBeNull();
    expect(events[0]!.newPlan).toBeNull();
  });

  // ── password change ────────────────────────────────────────────────────────────
  it('cambio de password → 1 evento changeKind password con old/new = null (SEGURIDAD)', async () => {
    const uc = new UpdatePppoeService(repo, router, nasRepo, orchestrator, catalogRepo, eventRepo);
    const id = await seedRadiusWithContract();
    await seedCatalog(catalogRepo);

    await uc.execute({ id, password: 'claveNueva123', actorId: 'A1', actorName: 'Op' });

    const events = await eventRepo.listByContract(CONTRACT_ID);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('modified');
    expect(events[0]!.changeKind).toBe('password');
    // La clave NUNCA se persiste — ni vieja ni nueva.
    expect(events[0]!.oldValue).toBeNull();
    expect(events[0]!.newValue).toBeNull();
  });

  it('password igual a la actual → NO se registra evento', async () => {
    const uc = new UpdatePppoeService(repo, router, nasRepo, orchestrator, catalogRepo, eventRepo);
    const id = await seedRadiusWithContract();
    await seedCatalog(catalogRepo);

    await uc.execute({ id, password: 'oldpass', actorId: 'A1', actorName: 'Op' });

    const events = await eventRepo.listByContract(CONTRACT_ID);
    expect(events).toHaveLength(0);
  });

  // ── status change ────────────────────────────────────────────────────────────
  it('cambio de status → 1 evento changeKind status con old/new', async () => {
    const uc = new UpdatePppoeService(repo, router, nasRepo, orchestrator, catalogRepo, eventRepo);
    const id = await seedRadiusWithContract();
    await seedCatalog(catalogRepo);

    await uc.execute({ id, status: 'disabled', actorId: 'A1', actorName: 'Op' });

    const events = await eventRepo.listByContract(CONTRACT_ID);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('modified');
    expect(events[0]!.changeKind).toBe('status');
    expect(events[0]!.oldValue).toBe('enabled');
    expect(events[0]!.newValue).toBe('disabled');
  });

  it('status igual al actual → NO se registra evento', async () => {
    const uc = new UpdatePppoeService(repo, router, nasRepo, orchestrator, catalogRepo, eventRepo);
    const id = await seedRadiusWithContract();
    await seedCatalog(catalogRepo);

    await uc.execute({ id, status: 'enabled', actorId: 'A1', actorName: 'Op' });

    const events = await eventRepo.listByContract(CONTRACT_ID);
    expect(events).toHaveLength(0);
  });

  // ── Combined (plan + IP) → plan event AND ip event ─────────────────────────────
  it('combinado plan + IP → evento de plan (oldPlan/newPlan) Y evento de ip, ambos registrados', async () => {
    const uc = new UpdatePppoeService(repo, router, nasRepo, orchestrator, catalogRepo, eventRepo);
    const id = await seedRadiusWithContract();
    await seedCatalog(catalogRepo);

    await uc.execute({
      id,
      profile: 'IP-Air-40-15',
      remoteAddress: '100.64.20.20',
      actorId: 'A1',
      actorName: 'Op',
    });

    const events = await eventRepo.listByContract(CONTRACT_ID);
    expect(events).toHaveLength(2);

    // Evento de PLAN — changeKind null, oldPlan/newPlan seteados (comportamiento existente).
    const planEvent = events.find(e => e.changeKind == null);
    expect(planEvent).toBeDefined();
    expect(planEvent!.eventType).toBe('modified');
    expect(planEvent!.oldPlan).toBe('IP-Air-30-10');
    expect(planEvent!.newPlan).toBe('IP-Air-40-15');

    // Evento de IP — changeKind 'ip', oldValue/newValue = IPs.
    const ipEvent = events.find(e => e.changeKind === 'ip');
    expect(ipEvent).toBeDefined();
    expect(ipEvent!.oldValue).toBe('100.64.10.10');
    expect(ipEvent!.newValue).toBe('100.64.20.20');
    // El evento de plan NO lleva oldValue/newValue.
    expect(planEvent!.oldValue).toBeNull();
    expect(planEvent!.newValue).toBeNull();
  });

  // ── No contractId → no event ───────────────────────────────────────────────────
  it('sin contractId → NO se registra evento aunque cambie la IP', async () => {
    const uc = new UpdatePppoeService(repo, router, nasRepo, orchestrator, catalogRepo, eventRepo);
    const id = await seedRadiusWithContract(null);
    await seedCatalog(catalogRepo);

    await uc.execute({ id, remoteAddress: '100.64.10.99', actorId: 'A1', actorName: 'Op' });

    expect(eventRepo.all()).toHaveLength(0);
  });

  // ── No change → no event ───────────────────────────────────────────────────────
  it('IP igual a la actual → NO se registra evento', async () => {
    const uc = new UpdatePppoeService(repo, router, nasRepo, orchestrator, catalogRepo, eventRepo);
    const id = await seedRadiusWithContract();
    await seedCatalog(catalogRepo);

    await uc.execute({ id, remoteAddress: '100.64.10.10', actorId: 'A1', actorName: 'Op' });

    const events = await eventRepo.listByContract(CONTRACT_ID);
    expect(events).toHaveLength(0);
  });

  // ── Back-compat: sin catalogRepo/eventRepo → no evento, no error ────────────────
  it('sin catalogRepo/eventRepo (back-compat) → cambio de IP no lanza ni registra', async () => {
    const uc = new UpdatePppoeService(repo, router, nasRepo, orchestrator);
    const id = await seedRadiusWithContract();

    const result = await uc.execute({ id, remoteAddress: '100.64.10.99' });
    expect(result.remoteAddress).toBe('100.64.10.99');
  });

  // ── Best-effort: eventRepo.record lanza → execute NO relanza ─────────────────────
  it('eventRepo.record lanza en un cambio de IP → execute NO relanza (best-effort)', async () => {
    const throwingEventRepo: InMemoryContractServiceEventRepository = {
      record: async () => { throw new Error('DB down'); },
      listByContract: async () => [],
      all: () => [],
    } as unknown as InMemoryContractServiceEventRepository;

    const uc = new UpdatePppoeService(repo, router, nasRepo, orchestrator, catalogRepo, throwingEventRepo);
    const id = await seedRadiusWithContract();
    await seedCatalog(catalogRepo);

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      uc.execute({ id, remoteAddress: '100.64.10.99', actorId: 'A1', actorName: 'Op' }),
    ).resolves.toBeDefined();

    warnSpy.mockRestore();
  });
});
