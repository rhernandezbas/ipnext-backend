/**
 * Tests that ListContracts.execute() applies deriveTechnology to the `technology`
 * field in ContractSummaryDto — manual value wins, else derived from plan.
 */
import { ListContracts } from '@application/use-cases/ListContracts';
import { InMemoryContractRepository } from '@infrastructure/adapters/in-memory/InMemoryContractRepository';

describe('ListContracts — ContractSummaryDto technology derivation', () => {
  it('derives "Wireless" for a contract with null technology + plan "50/25MB"', async () => {
    const repo = new InMemoryContractRepository();
    repo.seed({ clientName: 'Juan', plan: '50/25MB', technology: null });

    const useCase = new ListContracts(repo);
    const result = await useCase.execute({ page: 1, limit: 25 });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].technology).toBe('Wireless');
  });

  it('derives "Fiber" for a contract with null technology + plan "300MB"', async () => {
    const repo = new InMemoryContractRepository();
    repo.seed({ clientName: 'María', plan: '300MB', technology: null });

    const useCase = new ListContracts(repo);
    const result = await useCase.execute({ page: 1, limit: 25 });

    expect(result.data[0].technology).toBe('Fiber');
  });

  it('keeps null for a contract with null technology + non-numeric plan ("TV")', async () => {
    const repo = new InMemoryContractRepository();
    repo.seed({ clientName: 'Pedro', plan: 'TV', technology: null });

    const useCase = new ListContracts(repo);
    const result = await useCase.execute({ page: 1, limit: 25 });

    expect(result.data[0].technology).toBeNull();
  });

  it('preserves manual technology (FTTH) even when plan speed would suggest Wireless', async () => {
    const repo = new InMemoryContractRepository();
    repo.seed({ clientName: 'Laura', plan: '50/25MB', technology: 'FTTH' });

    const useCase = new ListContracts(repo);
    const result = await useCase.execute({ page: 1, limit: 25 });

    // Manual wins — should NOT become 'Wireless'
    expect(result.data[0].technology).toBe('FTTH');
  });

  it('preserves manual technology (Wireless) even when plan speed >= 100', async () => {
    const repo = new InMemoryContractRepository();
    repo.seed({ clientName: 'Carlos', plan: '300MB', technology: 'Wireless' });

    const useCase = new ListContracts(repo);
    const result = await useCase.execute({ page: 1, limit: 25 });

    // Manual wins — should NOT become 'Fiber'
    expect(result.data[0].technology).toBe('Wireless');
  });
});
