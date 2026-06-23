/**
 * Tests that ListContracts.execute() maps the raw GR `status` into the canonical
 * enum the frontend understands. Real use case + in-memory repo (no mocked use
 * case) so the seam is exercised end-to-end.
 *
 * Root cause: GR sends contract status as free text ("Vigente" / "Baja"); without
 * mapping, every contract rendered as "inactive" in the FE.
 */
import { ListContracts } from '@application/use-cases/ListContracts';
import { InMemoryContractRepository } from '@infrastructure/adapters/in-memory/InMemoryContractRepository';

describe('ListContracts — ContractSummaryDto status mapping', () => {
  it('maps raw GR "Vigente" → "active"', async () => {
    const repo = new InMemoryContractRepository();
    repo.seed({ clientName: 'Juan', plan: '300MB', status: 'Vigente' });

    const useCase = new ListContracts(repo);
    const result = await useCase.execute({ page: 1, limit: 25 });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].status).toBe('active');
  });

  it('maps raw GR "Baja" → "baja"', async () => {
    const repo = new InMemoryContractRepository();
    repo.seed({ clientName: 'María', plan: '50MB', status: 'Baja' });

    const useCase = new ListContracts(repo);
    const result = await useCase.execute({ page: 1, limit: 25 });

    expect(result.data[0].status).toBe('baja');
  });

  it('maps raw GR "Inactivo" → "inactive"', async () => {
    const repo = new InMemoryContractRepository();
    repo.seed({ clientName: 'Pedro', plan: '50MB', status: 'Inactivo' });

    const useCase = new ListContracts(repo);
    const result = await useCase.execute({ page: 1, limit: 25 });

    expect(result.data[0].status).toBe('inactive');
  });

  it('passes through an already-canonical "active"', async () => {
    const repo = new InMemoryContractRepository();
    repo.seed({ clientName: 'Laura', plan: '300MB', status: 'active' });

    const useCase = new ListContracts(repo);
    const result = await useCase.execute({ page: 1, limit: 25 });

    expect(result.data[0].status).toBe('active');
  });
});
