import type { ClientTvCancelStatusRepository, TvCancelStatusRow } from '@domain/ports/ClientTvCancelStatusRepository';

/**
 * In-memory adapter for ClientTvCancelStatusRepository (#10/#11).
 * Uses a Map<clientId, TvCancelStatusRow>. All operations are idempotent.
 *
 * `seedStatus(id, row)` — test helper: pre-seeds a row without calling setStatus().
 */
export class InMemoryClientTvCancelStatusRepository implements ClientTvCancelStatusRepository {
  private readonly store = new Map<string, TvCancelStatusRow>();

  /** Test helper — pre-seeds a status row for a client. */
  seedStatus(clientId: string, row: TvCancelStatusRow): void {
    this.store.set(clientId, row);
  }

  async getStatus(clientId: string): Promise<TvCancelStatusRow | null> {
    return this.store.get(clientId) ?? null;
  }

  async setStatus(clientId: string, row: TvCancelStatusRow): Promise<void> {
    this.store.set(clientId, row);
  }
}
