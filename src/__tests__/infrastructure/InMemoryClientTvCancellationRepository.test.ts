/**
 * #72 — InMemoryClientTvCancellationRepository: mark/clear/isCancelled idempotent.
 */
import { InMemoryClientTvCancellationRepository } from '@infrastructure/adapters/in-memory/InMemoryClientTvCancellationRepository';

describe('InMemoryClientTvCancellationRepository (#72)', () => {
  let repo: InMemoryClientTvCancellationRepository;

  beforeEach(() => {
    repo = new InMemoryClientTvCancellationRepository();
  });

  it('isCancelled returns false for unknown client', async () => {
    expect(await repo.isCancelled('cust-x')).toBe(false);
  });

  it('markCancelled → isCancelled true', async () => {
    await repo.markCancelled('cust-1');
    expect(await repo.isCancelled('cust-1')).toBe(true);
  });

  it('markCancelled is idempotent (double call is fine)', async () => {
    await repo.markCancelled('cust-1');
    await repo.markCancelled('cust-1');
    expect(await repo.isCancelled('cust-1')).toBe(true);
  });

  it('clearCancelled → isCancelled false', async () => {
    await repo.markCancelled('cust-1');
    await repo.clearCancelled('cust-1');
    expect(await repo.isCancelled('cust-1')).toBe(false);
  });

  it('clearCancelled is idempotent (no-op on non-cancelled)', async () => {
    await repo.clearCancelled('cust-x');
    expect(await repo.isCancelled('cust-x')).toBe(false);
  });

  it('seedCancelled pre-marks without going through markCancelled', async () => {
    repo.seedCancelled('cust-2');
    expect(await repo.isCancelled('cust-2')).toBe(true);
    // clearCancelled still works after seed
    await repo.clearCancelled('cust-2');
    expect(await repo.isCancelled('cust-2')).toBe(false);
  });

  it('flags are per-client (marking one does not affect another)', async () => {
    await repo.markCancelled('cust-A');
    expect(await repo.isCancelled('cust-B')).toBe(false);
  });
});
