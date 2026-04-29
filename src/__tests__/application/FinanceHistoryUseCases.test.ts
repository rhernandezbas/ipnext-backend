import { InMemoryFinanceHistoryRepository } from '../../infrastructure/adapters/in-memory/InMemoryFinanceHistoryRepository';
import { ListFinanceHistory } from '../../application/use-cases/ListFinanceHistory';

function makeRepo() {
  return new InMemoryFinanceHistoryRepository();
}

describe('ListFinanceHistory', () => {
  it('returns 15 seeded events', async () => {
    const repo = makeRepo();
    const uc = new ListFinanceHistory(repo);

    const result = await uc.execute();

    expect(result).toHaveLength(15);
  });

  it('filters by clientId', async () => {
    const repo = makeRepo();
    const uc = new ListFinanceHistory(repo);

    const result = await uc.execute({ clientId: 'cli-001' });

    expect(result.length).toBeGreaterThan(0);
    result.forEach(e => expect(e.clientId).toBe('cli-001'));
  });

  it('filters by date range', async () => {
    const repo = makeRepo();
    const uc = new ListFinanceHistory(repo);

    const result = await uc.execute({ from: '2024-04-01T00:00:00Z', to: '2024-04-15T23:59:59Z' });

    expect(result.length).toBeGreaterThan(0);
    result.forEach(e => {
      const d = new Date(e.occurredAt);
      expect(d >= new Date('2024-04-01T00:00:00Z')).toBe(true);
      expect(d <= new Date('2024-04-15T23:59:59Z')).toBe(true);
    });
  });
});
