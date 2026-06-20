/**
 * DeassociatePppoeFromContract (#2) — TDD: escrito ANTES de la implementación.
 *
 * Escenarios:
 *   - éxito: contractId=null, status='enabled' (status INTACTO)
 *   - PPPoE no existe → PppoeServiceNotFoundError
 *   - PPPoE de OTRO contrato → PppoeServiceNotFoundError (mismatch de ownership)
 */
import { DeassociatePppoeFromContract } from '@application/use-cases/DeassociatePppoeFromContract';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { PppoeServiceNotFoundError } from '@domain/errors/pppoe';
import { EnsureInternetContractService } from '@application/use-cases/EnsureInternetContractService';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';

function makeEnsure(csRepo: InMemoryContractServiceRepository, catalogRepo: InMemoryServiceCatalogRepository) {
  return new EnsureInternetContractService(csRepo, catalogRepo);
}

describe('DeassociatePppoeFromContract', () => {
  let pppoeRepo: InMemoryPppoeServiceRepository;
  let csRepo: InMemoryContractServiceRepository;
  let catalogRepo: InMemoryServiceCatalogRepository;
  let uc: DeassociatePppoeFromContract;

  beforeEach(() => {
    pppoeRepo = new InMemoryPppoeServiceRepository();
    csRepo = new InMemoryContractServiceRepository();
    catalogRepo = new InMemoryServiceCatalogRepository();
    uc = new DeassociatePppoeFromContract(pppoeRepo, makeEnsure(csRepo, catalogRepo));
  });

  it('éxito: contractId=null, status intacto (enabled)', async () => {
    const s = await pppoeRepo.upsertByUsername({
      username: 'juan', password: 'p', nasId: '1', contractId: 'C1', status: 'enabled',
    });
    const result = await uc.execute(s.id, 'C1');
    expect(result.contractId).toBeNull();
    expect(result.status).toBe('enabled'); // status NO se toca
  });

  it('PPPoE no existe → PppoeServiceNotFoundError', async () => {
    await expect(uc.execute('no-existe', 'C1')).rejects.toBeInstanceOf(PppoeServiceNotFoundError);
  });

  it('PPPoE de OTRO contrato → PppoeServiceNotFoundError (no desasociar contrato ajeno)', async () => {
    const s = await pppoeRepo.upsertByUsername({
      username: 'juan', password: 'p', nasId: '1', contractId: 'C1', status: 'enabled',
    });
    // intentar desasociar como si fuera del contrato C2 → error
    await expect(uc.execute(s.id, 'C2')).rejects.toBeInstanceOf(PppoeServiceNotFoundError);
  });

  it('PPPoE huérfano (contractId=null) → PppoeServiceNotFoundError (no pertenece al contrato)', async () => {
    const orphan = await pppoeRepo.upsertByUsername({
      username: 'orphan', password: 'p', nasId: '1', contractId: null,
    });
    await expect(uc.execute(orphan.id, 'C1')).rejects.toBeInstanceOf(PppoeServiceNotFoundError);
  });
});
