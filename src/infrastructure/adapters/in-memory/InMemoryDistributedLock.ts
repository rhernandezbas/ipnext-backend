import { DistributedLock } from '@domain/ports/DistributedLock';

/**
 * In-memory implementation of DistributedLock for use in unit tests.
 *
 * By default every tryAcquire succeeds (mimics an uncontested lock).
 * Set `forceAcquireFails = true` to make all tryAcquire calls return false,
 * which lets tests verify the "lock held elsewhere → skip" path.
 */
export class InMemoryDistributedLock implements DistributedLock {
  /** Keys currently held by this instance. */
  readonly heldKeys = new Set<string>();
  /** When true, tryAcquire always returns false (simulates lock contention). */
  forceAcquireFails = false;

  async tryAcquire(key: string): Promise<boolean> {
    if (this.forceAcquireFails) return false;
    if (this.heldKeys.has(key)) return false;
    this.heldKeys.add(key);
    return true;
  }

  async release(key: string): Promise<void> {
    this.heldKeys.delete(key);
  }
}
