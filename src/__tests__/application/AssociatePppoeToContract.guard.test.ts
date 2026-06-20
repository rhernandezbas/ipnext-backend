/**
 * AssociatePppoeToContract — guard de unicidad (#4).
 *
 * TDD: escrito ANTES de la implementación.
 *
 * Escenarios:
 *   - contrato con PPPoE enabled existente → PppoeContractAlreadyHasServiceError
 *   - mismo PPPoE→mismo contrato → idempotente (sin error)
 *   - PPPoE disabled existente NO bloquea (solo 'enabled' ocupa el slot)
 *   - asociar huérfano a contrato libre → OK
 */
import { AssociatePppoeToContract } from '@application/use-cases/AssociatePppoeToContract';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { PppoeContractAlreadyHasServiceError, PppoeAlreadyAssociatedError } from '@domain/errors/pppoe';
import { EnsureInternetContractService } from '@application/use-cases/EnsureInternetContractService';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';

function makeEnsure(csRepo: InMemoryContractServiceRepository, catalogRepo: InMemoryServiceCatalogRepository) {
  return new EnsureInternetContractService(csRepo, catalogRepo);
}

describe('AssociatePppoeToContract — guard #4 (unicidad por contrato)', () => {
  let pppoeRepo: InMemoryPppoeServiceRepository;
  let csRepo: InMemoryContractServiceRepository;
  let catalogRepo: InMemoryServiceCatalogRepository;
  let uc: AssociatePppoeToContract;

  beforeEach(() => {
    pppoeRepo = new InMemoryPppoeServiceRepository();
    csRepo = new InMemoryContractServiceRepository();
    catalogRepo = new InMemoryServiceCatalogRepository();
    uc = new AssociatePppoeToContract(pppoeRepo, makeEnsure(csRepo, catalogRepo));
  });

  it('contrato con PPPoE enabled → PppoeContractAlreadyHasServiceError', async () => {
    // Seed: contrato C1 ya tiene un PPPoE enabled
    await pppoeRepo.upsertByUsername({ username: 'existente', password: 'p', nasId: '1', contractId: 'C1', status: 'enabled' });
    // Nuevo PPPoE huérfano que quiere asociarse al mismo contrato
    const orphan = await pppoeRepo.upsertByUsername({ username: 'orphan', password: 'p', nasId: '1', contractId: null });

    await expect(uc.execute(orphan.id, 'C1')).rejects.toBeInstanceOf(PppoeContractAlreadyHasServiceError);
  });

  it('mismo PPPoE→mismo contrato → idempotente (sin error)', async () => {
    const s = await pppoeRepo.upsertByUsername({ username: 'juan', password: 'p', nasId: '1', contractId: 'C1', status: 'enabled' });
    // Re-asociar el MISMO PPPoE al MISMO contrato NO es error
    const result = await uc.execute(s.id, 'C1');
    expect(result.contractId).toBe('C1');
  });

  it('PPPoE disabled NO bloquea — se puede asociar otro enabled', async () => {
    // Un PPPoE disabled en el contrato NO ocupa el slot
    await pppoeRepo.upsertByUsername({ username: 'dado-de-baja', password: 'p', nasId: '1', contractId: 'C1', status: 'disabled' });
    const orphan = await pppoeRepo.upsertByUsername({ username: 'nuevo', password: 'p', nasId: '1', contractId: null });

    const result = await uc.execute(orphan.id, 'C1');
    expect(result.contractId).toBe('C1');
    expect(result.status).toBe('enabled');
  });

  it('huérfano a contrato libre → OK (sin guard)', async () => {
    const orphan = await pppoeRepo.upsertByUsername({ username: 'libre', password: 'p', nasId: '1', contractId: null });
    const result = await uc.execute(orphan.id, 'C2');
    expect(result.contractId).toBe('C2');
  });

  it('PPPoE ya asociado a OTRO contrato → PppoeAlreadyAssociatedError (guard existente intacto)', async () => {
    const s = await pppoeRepo.upsertByUsername({ username: 'robado', password: 'p', nasId: '1', contractId: 'C1', status: 'enabled' });
    await expect(uc.execute(s.id, 'C2')).rejects.toBeInstanceOf(PppoeAlreadyAssociatedError);
  });

  it('best-effort: si ensureInternet LANZA, la asociación NO se rompe (el PPPoE queda asociado)', async () => {
    // El reconcile de la línea INTERNET es best-effort: un fallo (catálogo/csRepo) NUNCA
    // debe abortar la asociación. Inyectamos un ensureInternet que siempre lanza.
    const throwingEnsure = {
      execute: async () => { throw new Error('csRepo.add explotó (simulado)'); },
    } as unknown as EnsureInternetContractService;
    const ucThrows = new AssociatePppoeToContract(pppoeRepo, throwingEnsure);
    const orphan = await pppoeRepo.upsertByUsername({ username: 'libre', password: 'p', nasId: '1', contractId: null });

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await ucThrows.execute(orphan.id, 'C9');

    expect(result.contractId).toBe('C9'); // la asociación se completó pese al fallo del reconcile
    expect(warnSpy).toHaveBeenCalled();    // el fallo se logueó (best-effort, no silencioso)
    warnSpy.mockRestore();
  });
});
