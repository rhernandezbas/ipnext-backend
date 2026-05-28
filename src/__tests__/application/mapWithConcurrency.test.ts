/**
 * TDD — mapWithConcurrency (task-bulk-send-to-iclass, AD-2)
 * Bounded-concurrency map: processes all items, respects the limit, preserves order.
 */
import { mapWithConcurrency } from '../../application/util/mapWithConcurrency';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('mapWithConcurrency', () => {
  it('processes ALL items and preserves order (results[i] <-> items[i])', async () => {
    const items = [1, 2, 3, 4, 5, 6, 7];
    const results = await mapWithConcurrency(items, 3, async (n) => {
      await tick(Math.random() * 5);
      return n * 10;
    });
    expect(results).toEqual([10, 20, 30, 40, 50, 60, 70]);
  });

  it('never runs more than `limit` fns at once', async () => {
    let active = 0;
    let maxObserved = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);

    await mapWithConcurrency(items, 5, async (n) => {
      active++;
      maxObserved = Math.max(maxObserved, active);
      await tick(5 + (n % 3) * 3); // varying durations
      active--;
      return n;
    });

    expect(maxObserved).toBeLessThanOrEqual(5);
    expect(maxObserved).toBeGreaterThan(1); // actually ran concurrently
  });

  it('handles an empty list', async () => {
    expect(await mapWithConcurrency([], 5, async (n) => n)).toEqual([]);
  });

  it('handles a limit larger than the item count', async () => {
    const results = await mapWithConcurrency([1, 2], 10, async (n) => n + 1);
    expect(results).toEqual([2, 3]);
  });
});
