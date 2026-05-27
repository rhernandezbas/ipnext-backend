/**
 * Port for a distributed mutual-exclusion lock. Implementations must work
 * correctly across multiple processes (e.g. multiple backend replicas).
 *
 * Contract:
 *  - tryAcquire returns true  → caller owns the lock and MUST call release.
 *  - tryAcquire returns false → lock held elsewhere; caller does nothing.
 *  - release is idempotent; calling it when the lock is not held is a no-op.
 */
export interface DistributedLock {
  tryAcquire(key: string): Promise<boolean>;
  release(key: string): Promise<void>;
}
