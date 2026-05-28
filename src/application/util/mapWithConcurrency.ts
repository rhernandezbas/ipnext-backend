/**
 * Maps `items` through async `fn` with at most `limit` concurrent executions.
 * Preserves order: `results[i]` corresponds to `items[i]`. A worker-pool model —
 * each of up to `limit` workers pulls the next index until the queue drains.
 *
 * Pure (no infra). If `fn` rejects, the rejection propagates; callers that need
 * partial results (e.g. bulk move) must capture errors inside `fn`.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const workers = Math.max(1, Math.min(limit, items.length));
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}
