/**
 * PppoeAltaOperador — fix-operador-alta (pppoe-plan-change-history).
 *
 * TDD: escritos ANTES de la implementación.
 *
 * Invariante: el alta de PPPoE (crear o asociar) SIEMPRE registra exactamente UN evento
 * 'activated' CON actorName, sin importar si la línea INTERNET ya estaba activa o no.
 *
 * Casos:
 *   A. CreatePppoeService: línea INTERNET recién creada → 1 evento 'activated' con actor.
 *   B. CreatePppoeService: línea INTERNET ya activa (no-op de ensureInternet) → 1 evento 'activated' con actor.
 *   C. AssociatePppoeToContract: línea INTERNET recién creada → 1 evento 'activated' con actor.
 *   D. AssociatePppoeToContract: línea INTERNET ya activa → 1 evento 'activated' con actor.
 *   E. Sin actor: transición nueva → 1 evento con actorName='' (comportamiento legacy).
 *   F. Sin actor + ya activa: NO se registra evento extra (sin actor, no hay dato que salvar).
 */
import { CreatePppoeService } from '@application/use-cases/CreatePppoeService';
import { AssociatePppoeToContract } from '@application/use-cases/AssociatePppoeToContract';
import { EnsureInternetContractService } from '@application/use-cases/EnsureInternetContractService';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryRouterGateway } from '@infrastructure/adapters/in-memory/InMemoryRouterGateway';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';

const NAS_ID_API = '1';     // mikrotik_api
const CONTRACT_ID = 'C99';
const ACTOR = { actorId: 'U1', actorName: 'Operador' };

async function seedCatalog(catalogRepo: InMemoryServiceCatalogRepository) {
  const catalog = await catalogRepo.create({ name: 'INTERNET', label: 'Internet', active: true, sortOrder: 1 });
  catalogRepo.itemCounts[catalog.id] = 0;
  return catalog;
}

async function seedActiveInternetLine(
  csRepo: InMemoryContractServiceRepository,
  catalogRepo: InMemoryServiceCatalogRepository,
  contractId: string,
) {
  const catalog = await seedCatalog(catalogRepo);
  // Inject the catalog info so getByPair works
  csRepo.catalog = csRepo.catalog ?? {};
  csRepo.catalog[catalog.id] = { name: 'INTERNET', label: 'Internet' };
  await csRepo.add({ contractId, serviceCatalogId: catalog.id });
  return catalog;
}

function makeCreateUc(
  repos: {
    pppoeRepo: InMemoryPppoeServiceRepository;
    router: InMemoryRouterGateway;
    nasRepo: InMemoryNasRepository;
    orchestrator: InMemoryRadiusOrchestratorGateway;
    csRepo: InMemoryContractServiceRepository;
    catalogRepo: InMemoryServiceCatalogRepository;
    eventRepo: InMemoryContractServiceEventRepository;
  },
): CreatePppoeService {
  const ensure = new EnsureInternetContractService(repos.csRepo, repos.catalogRepo, repos.eventRepo);
  return new CreatePppoeService(
    repos.pppoeRepo,
    repos.router,
    repos.nasRepo,
    repos.orchestrator,
    ensure,
    repos.catalogRepo,
    repos.eventRepo,
  );
}

function makeAssociateUc(
  repos: {
    pppoeRepo: InMemoryPppoeServiceRepository;
    csRepo: InMemoryContractServiceRepository;
    catalogRepo: InMemoryServiceCatalogRepository;
    eventRepo: InMemoryContractServiceEventRepository;
  },
): AssociatePppoeToContract {
  const ensure = new EnsureInternetContractService(repos.csRepo, repos.catalogRepo, repos.eventRepo);
  return new AssociatePppoeToContract(repos.pppoeRepo, ensure, repos.catalogRepo, repos.eventRepo);
}

// ── A. CreatePppoeService: línea INTERNET recién creada ──────────────────────
describe('CreatePppoeService — fix-operador-alta', () => {
  it('A. línea INTERNET no existe (nueva transición) → exactamente 1 evento activated con actor', async () => {
    const pppoeRepo   = new InMemoryPppoeServiceRepository();
    const csRepo      = new InMemoryContractServiceRepository();
    const catalogRepo = new InMemoryServiceCatalogRepository();
    const eventRepo   = new InMemoryContractServiceEventRepository();

    await seedCatalog(catalogRepo);

    const uc = makeCreateUc({
      pppoeRepo,
      router: new InMemoryRouterGateway(),
      nasRepo: new InMemoryNasRepository(),
      orchestrator: new InMemoryRadiusOrchestratorGateway(),
      csRepo,
      catalogRepo,
      eventRepo,
    });

    await uc.execute(
      { contractId: CONTRACT_ID, username: 'user-a', password: 'pw', nasId: NAS_ID_API },
      ACTOR,
    );

    const events = await eventRepo.listByContract(CONTRACT_ID);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('activated');
    expect(events[0]!.actorName).toBe('Operador');
    expect(events[0]!.actorId).toBe('U1');
  });

  it('B. línea INTERNET ya activa (no-op de ensureInternet) → exactamente 1 evento activated con actor', async () => {
    const pppoeRepo   = new InMemoryPppoeServiceRepository();
    const csRepo      = new InMemoryContractServiceRepository();
    const catalogRepo = new InMemoryServiceCatalogRepository();
    const eventRepo   = new InMemoryContractServiceEventRepository();

    // Pre-seed an active INTERNET line
    await seedActiveInternetLine(csRepo, catalogRepo, CONTRACT_ID);

    const uc = makeCreateUc({
      pppoeRepo,
      router: new InMemoryRouterGateway(),
      nasRepo: new InMemoryNasRepository(),
      orchestrator: new InMemoryRadiusOrchestratorGateway(),
      csRepo,
      catalogRepo,
      eventRepo,
    });

    await uc.execute(
      { contractId: CONTRACT_ID, username: 'user-b', password: 'pw', nasId: NAS_ID_API },
      ACTOR,
    );

    // ensureInternet no-ops (already active) → fallback recording kicks in
    const events = await eventRepo.listByContract(CONTRACT_ID);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('activated');
    expect(events[0]!.actorName).toBe('Operador');
    expect(events[0]!.actorId).toBe('U1');
  });

  it('E. sin actor + línea nueva → 1 evento con actorName="" (legacy)', async () => {
    const pppoeRepo   = new InMemoryPppoeServiceRepository();
    const csRepo      = new InMemoryContractServiceRepository();
    const catalogRepo = new InMemoryServiceCatalogRepository();
    const eventRepo   = new InMemoryContractServiceEventRepository();

    await seedCatalog(catalogRepo);

    const uc = makeCreateUc({
      pppoeRepo,
      router: new InMemoryRouterGateway(),
      nasRepo: new InMemoryNasRepository(),
      orchestrator: new InMemoryRadiusOrchestratorGateway(),
      csRepo,
      catalogRepo,
      eventRepo,
    });

    // No actor passed
    await uc.execute({ contractId: CONTRACT_ID, username: 'user-e', password: 'pw', nasId: NAS_ID_API });

    const events = await eventRepo.listByContract(CONTRACT_ID);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('activated');
    expect(events[0]!.actorName).toBe('');
  });

  it('F. sin actor + línea ya activa → 0 eventos (no hay dato de actor que salvar)', async () => {
    const pppoeRepo   = new InMemoryPppoeServiceRepository();
    const csRepo      = new InMemoryContractServiceRepository();
    const catalogRepo = new InMemoryServiceCatalogRepository();
    const eventRepo   = new InMemoryContractServiceEventRepository();

    await seedActiveInternetLine(csRepo, catalogRepo, CONTRACT_ID);

    const uc = makeCreateUc({
      pppoeRepo,
      router: new InMemoryRouterGateway(),
      nasRepo: new InMemoryNasRepository(),
      orchestrator: new InMemoryRadiusOrchestratorGateway(),
      csRepo,
      catalogRepo,
      eventRepo,
    });

    // No actor passed → ensureInternet no-ops → no fallback recording (no actor)
    await uc.execute({ contractId: CONTRACT_ID, username: 'user-f', password: 'pw', nasId: NAS_ID_API });

    const events = await eventRepo.listByContract(CONTRACT_ID);
    expect(events).toHaveLength(0);
  });
});

// ── C/D. AssociatePppoeToContract: fix-operador-alta ────────────────────────
describe('AssociatePppoeToContract — fix-operador-alta', () => {
  it('C. línea INTERNET no existe (nueva transición) → exactamente 1 evento activated con actor', async () => {
    const pppoeRepo   = new InMemoryPppoeServiceRepository();
    const csRepo      = new InMemoryContractServiceRepository();
    const catalogRepo = new InMemoryServiceCatalogRepository();
    const eventRepo   = new InMemoryContractServiceEventRepository();

    await seedCatalog(catalogRepo);

    const orphan = await pppoeRepo.upsertByUsername({
      username: 'orphan-c', password: 'p', nasId: NAS_ID_API, contractId: null,
    });

    const uc = makeAssociateUc({ pppoeRepo, csRepo, catalogRepo, eventRepo });
    await uc.execute(orphan.id, CONTRACT_ID, ACTOR);

    const events = await eventRepo.listByContract(CONTRACT_ID);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('activated');
    expect(events[0]!.actorName).toBe('Operador');
    expect(events[0]!.actorId).toBe('U1');
  });

  it('D. línea INTERNET ya activa → exactamente 1 evento activated con actor (no-op → fallback)', async () => {
    const pppoeRepo   = new InMemoryPppoeServiceRepository();
    const csRepo      = new InMemoryContractServiceRepository();
    const catalogRepo = new InMemoryServiceCatalogRepository();
    const eventRepo   = new InMemoryContractServiceEventRepository();

    // Pre-seed active INTERNET line
    await seedActiveInternetLine(csRepo, catalogRepo, CONTRACT_ID);

    const orphan = await pppoeRepo.upsertByUsername({
      username: 'orphan-d', password: 'p', nasId: NAS_ID_API, contractId: null,
    });

    const uc = makeAssociateUc({ pppoeRepo, csRepo, catalogRepo, eventRepo });
    await uc.execute(orphan.id, CONTRACT_ID, ACTOR);

    // Should record exactly one event even though ensureInternet no-ops
    const events = await eventRepo.listByContract(CONTRACT_ID);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('activated');
    expect(events[0]!.actorName).toBe('Operador');
    expect(events[0]!.actorId).toBe('U1');
  });
});
