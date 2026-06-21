/**
 * DeactivatePppoeService — propagación de reason al evento (pppoe-baja-motivo).
 *
 * TDD: escrito ANTES de la implementación.
 *
 * Escenarios:
 *   - execute(id, { reason, actorId, actorName }) → evento 'deactivated' con reason
 *   - execute(id, { reason: null }) → evento 'deactivated' con reason=null
 *   - execute(id) sin opts → execute sin fallo (back-compat)
 *   - sin contractId → no se registra evento
 */
import { DeactivatePppoeService } from '@application/use-cases/DeactivatePppoeService';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryRouterGateway } from '@infrastructure/adapters/in-memory/InMemoryRouterGateway';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { EnsureInternetContractService } from '@application/use-cases/EnsureInternetContractService';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';

const NAS_ID = '1'; // matches InMemoryNasRepository default NAS #1

function makeUc(opts: {
  csRepo?: InMemoryContractServiceRepository;
  catalogRepo?: InMemoryServiceCatalogRepository;
  eventRepo?: InMemoryContractServiceEventRepository;
  pppoeRepo?: InMemoryPppoeServiceRepository;
  nasRepo?: InMemoryNasRepository;
  router?: InMemoryRouterGateway;
  orchestrator?: InMemoryRadiusOrchestratorGateway;
}) {
  const pppoeRepo = opts.pppoeRepo ?? new InMemoryPppoeServiceRepository();
  const router = opts.router ?? new InMemoryRouterGateway();
  const nasRepo = opts.nasRepo ?? new InMemoryNasRepository();
  const orchestrator = opts.orchestrator ?? new InMemoryRadiusOrchestratorGateway();
  const csRepo = opts.csRepo ?? new InMemoryContractServiceRepository();
  const catalogRepo = opts.catalogRepo ?? new InMemoryServiceCatalogRepository();
  const ensure = new EnsureInternetContractService(csRepo, catalogRepo, opts.eventRepo);
  const uc = new DeactivatePppoeService(pppoeRepo, router, nasRepo, orchestrator, ensure);
  return { uc, pppoeRepo, csRepo, catalogRepo };
}

describe('DeactivatePppoeService — eventos (pppoe-baja-motivo)', () => {
  it('pasa reason+actor → evento deactivated registrado con esos valores', async () => {
    const eventRepo = new InMemoryContractServiceEventRepository();
    const csRepo = new InMemoryContractServiceRepository();
    const catalogRepo = new InMemoryServiceCatalogRepository();

    // Seed catálogo INTERNET
    const catalog = await catalogRepo.create({ name: 'INTERNET', label: 'Internet', active: true, sortOrder: 1 });
    csRepo.catalog[catalog.id] = { name: 'INTERNET', label: 'Internet' };

    const { uc, pppoeRepo } = makeUc({ eventRepo, csRepo, catalogRepo });

    // PPPoE vinculado al contrato C1, con línea INTERNET activa
    await csRepo.add({ contractId: 'C1', serviceCatalogId: catalog.id });
    const row = await pppoeRepo.upsertByUsername({
      username: 'user1', password: 'p', nasId: NAS_ID, contractId: 'C1', status: 'enabled',
    });

    await uc.execute(row.id, { reason: 'baja voluntaria', actorId: 'A1', actorName: 'Admin' });

    const events = await eventRepo.listByContract('C1');
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('deactivated');
    expect(events[0]!.reason).toBe('baja voluntaria');
    expect(events[0]!.actorId).toBe('A1');
    expect(events[0]!.actorName).toBe('Admin');
  });

  it('pasa reason=null → evento con reason=null', async () => {
    const eventRepo = new InMemoryContractServiceEventRepository();
    const csRepo = new InMemoryContractServiceRepository();
    const catalogRepo = new InMemoryServiceCatalogRepository();
    const catalog = await catalogRepo.create({ name: 'INTERNET', label: 'Internet', active: true, sortOrder: 1 });
    csRepo.catalog[catalog.id] = { name: 'INTERNET', label: 'Internet' };

    const { uc, pppoeRepo } = makeUc({ eventRepo, csRepo, catalogRepo });
    await csRepo.add({ contractId: 'C1', serviceCatalogId: catalog.id });
    const row = await pppoeRepo.upsertByUsername({
      username: 'user2', password: 'p', nasId: NAS_ID, contractId: 'C1', status: 'enabled',
    });

    await uc.execute(row.id, { reason: null });

    const events = await eventRepo.listByContract('C1');
    expect(events).toHaveLength(1);
    expect(events[0]!.reason).toBeNull();
  });

  it('sin opts (back-compat) → baja exitosa sin evento de reason', async () => {
    const { uc, pppoeRepo } = makeUc({});
    const row = await pppoeRepo.upsertByUsername({
      username: 'user3', password: 'p', nasId: NAS_ID, contractId: null, status: 'enabled',
    });
    // No debe lanzar aunque no haya opts
    await expect(uc.execute(row.id)).resolves.toBeDefined();
  });

  it('sin contractId → no hay evento (no hay contrato que reconciliar)', async () => {
    const eventRepo = new InMemoryContractServiceEventRepository();
    const { uc, pppoeRepo } = makeUc({ eventRepo });
    const row = await pppoeRepo.upsertByUsername({
      username: 'orphan', password: 'p', nasId: NAS_ID, contractId: null, status: 'enabled',
    });

    await uc.execute(row.id, { reason: 'cualquier motivo', actorId: 'A1', actorName: 'Admin' });

    const events = eventRepo.all();
    expect(events).toHaveLength(0);
  });
});
