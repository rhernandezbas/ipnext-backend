/**
 * STRICT TDD — GR vendedor mapping (Fase 2b).
 * ListDistinctVendedores feeds the FE dropdown with the GR `Contract.vendedor`
 * catalog: distinct, non-null, alphabetically ordered.
 */
import { ListDistinctVendedores } from '@application/use-cases/ListDistinctVendedores';
import { InMemoryContractRepository } from '@infrastructure/adapters/in-memory/InMemoryContractRepository';

describe('ListDistinctVendedores', () => {
  it('returns distinct vendedor names, alphabetically ordered, filtering null', async () => {
    const repo = new InMemoryContractRepository();
    repo.seed({ clientName: 'C1', plan: 'P', vendedor: 'JUAN PEREZ' });
    repo.seed({ clientName: 'C2', plan: 'P', vendedor: 'ANA GOMEZ' });
    repo.seed({ clientName: 'C3', plan: 'P', vendedor: 'JUAN PEREZ' }); // duplicate
    repo.seed({ clientName: 'C4', plan: 'P', vendedor: null }); // null → filtered
    repo.seed({ clientName: 'C5', plan: 'P' }); // missing → filtered

    const uc = new ListDistinctVendedores(repo);
    const result = await uc.execute();

    expect(result).toEqual(['ANA GOMEZ', 'JUAN PEREZ']);
  });

  it('returns an empty array when there are no vendedores', async () => {
    const repo = new InMemoryContractRepository();
    repo.seed({ clientName: 'C1', plan: 'P', vendedor: null });

    const uc = new ListDistinctVendedores(repo);
    const result = await uc.execute();

    expect(result).toEqual([]);
  });
});
