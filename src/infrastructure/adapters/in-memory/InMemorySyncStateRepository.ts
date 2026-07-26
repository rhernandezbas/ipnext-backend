import { SyncStateRepository, SyncState } from '@domain/ports/SyncStateRepository';

export class InMemorySyncStateRepository implements SyncStateRepository {
  states = new Map<string, SyncState>();

  async get(entity: string): Promise<SyncState | null> {
    return this.states.get(entity) ?? null;
  }

  async save(state: SyncState): Promise<void> {
    this.states.set(state.entity, { ...state });
  }

  /** fix-wave-2 R2 — targeted single-field update; no-op if the row doesn't exist. */
  async clearLastRunAt(entity: string): Promise<void> {
    const prior = this.states.get(entity);
    if (!prior) return;
    this.states.set(entity, { ...prior, lastRunAt: null });
  }

  /**
   * fix-wave-2 R6 — targeted 2-field update (`cursor`/`lastResult` ONLY).
   * Synchronous read+write (no `await` in between) so no concurrent caller
   * can interleave inside this method — the closest in-memory analogue of a
   * real single-statement SQL `UPDATE ... SET cursor=?, lastResult=?`.
   */
  async rearmCursor(entity: string, cursor: string, lastResult: string): Promise<void> {
    const existing = this.states.get(entity);
    if (existing) {
      this.states.set(entity, { ...existing, cursor, lastResult });
    } else {
      this.states.set(entity, { entity, cursor, lastResult, lastRunAt: null, itemsSynced: 0 });
    }
  }
}
