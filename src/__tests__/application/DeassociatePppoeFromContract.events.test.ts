/**
 * DeassociatePppoeFromContract — propagación de reason al evento (pppoe-baja-motivo).
 *
 * TDD: escrito ANTES de la implementación.
 *
 * Escenarios:
 *   - execute(pppoeId, contractId, { reason, actorId, actorName }) → evento 'deactivated' con reason
 *   - execute(pppoeId, contractId, { reason: null }) → evento con reason=null
 *   - execute(pppoeId, contractId) sin opts → back-compat, funciona sin error
 */
import { DeassociatePppoeFromContract } from '@application/use-cases/DeassociatePppoeFromContract';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { EnsureInternetContractService } from '@application/use-cases/EnsureInternetContractService';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';

function makeUc(opts: {
  eventRepo?: InMemoryContractServiceEventRepository;
  pppoeRepo?: InMemoryPppoeServiceRepository;
  csRepo?: InMemoryContractServiceRepository;
  catalogRepo?: InMemoryServiceCatalogRepository;
}) {
  const pppoeRepo = opts.pppoeRepo ?? new InMemoryPppoeServiceRepository();
  const csRepo = opts.csRepo ?? new InMemoryContractServiceRepository();
  const catalogRepo = opts.catalogRepo ?? new InMemoryServiceCatalogRepository();
  const ensure = new EnsureInternetContractService(csRepo, catalogRepo, opts.eventRepo);
  const uc = new DeassociatePppoeFromContract(pppoeRepo, ensure);
  return { uc, pppoeRepo, csRepo, catalogRepo };
}

const NAS_ID = '1';

describe('DeassociatePppoeFromContract — eventos (pppoe-baja-motivo)', () => {
  it('pasa reason+actor → evento deactivated registrado con esos valores', async () => {
    const eventRepo = new InMemoryContractServiceEventRepository();
    const csRepo = new InMemoryContractServiceRepository();
    const catalogRepo = new InMemoryServiceCatalogRepository();

    // Seed catálogo INTERNET
    const catalog = await catalogRepo.create({ name: 'INTERNET', label: 'Internet', active: true, sortOrder: 1 });
    csRepo.catalog[catalog.id] = { name: 'INTERNET', label: 'Internet' };
    await csRepo.add({ contractId: 'C1', serviceCatalogId: catalog.id });

    const { uc, pppoeRepo } = makeUc({ eventRepo, csRepo, catalogRepo });

    const row = await pppoeRepo.upsertByUsername({
      username: 'user1', password: 'p', nasId: NAS_ID, contractId: 'C1', status: 'enabled',
    });

    const result = await uc.execute(row.id, 'C1', { reason: 'desasociar por cambio de plan', actorId: 'A2', actorName: 'Operador' });

    expect(result.contractId).toBeNull(); // desvinculado
    const events = await eventRepo.listByContract('C1');
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('deactivated');
    expect(events[0]!.reason).toBe('desasociar por cambio de plan');
    expect(events[0]!.actorId).toBe('A2');
    expect(events[0]!.actorName).toBe('Operador');
  });

  it('pasa reason=null → evento con reason=null', async () => {
    const eventRepo = new InMemoryContractServiceEventRepository();
    const csRepo = new InMemoryContractServiceRepository();
    const catalogRepo = new InMemoryServiceCatalogRepository();
    const catalog = await catalogRepo.create({ name: 'INTERNET', label: 'Internet', active: true, sortOrder: 1 });
    csRepo.catalog[catalog.id] = { name: 'INTERNET', label: 'Internet' };
    await csRepo.add({ contractId: 'C1', serviceCatalogId: catalog.id });

    const { uc, pppoeRepo } = makeUc({ eventRepo, csRepo, catalogRepo });
    const row = await pppoeRepo.upsertByUsername({
      username: 'user2', password: 'p', nasId: NAS_ID, contractId: 'C1', status: 'enabled',
    });

    await uc.execute(row.id, 'C1', { reason: null });

    const events = await eventRepo.listByContract('C1');
    expect(events).toHaveLength(1);
    expect(events[0]!.reason).toBeNull();
  });

  it('sin opts (back-compat) → desasocia sin error', async () => {
    const { uc, pppoeRepo } = makeUc({});
    const row = await pppoeRepo.upsertByUsername({
      username: 'user3', password: 'p', nasId: NAS_ID, contractId: 'C1', status: 'enabled',
    });

    // Sin opts ni catálogo INTERNET → ensureInternet es no-op, no debe lanzar
    await expect(uc.execute(row.id, 'C1')).resolves.toBeDefined();
  });
});
