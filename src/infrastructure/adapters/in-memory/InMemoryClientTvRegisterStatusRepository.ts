import type { ClientTvRegisterStatusRepository, TvRegisterStatusRow } from '@domain/ports/ClientTvRegisterStatusRepository';

/**
 * Adapter in-memory de ClientTvRegisterStatusRepository (gigared-alta-asincrona W1.2).
 * Map<clientId, TvRegisterStatusRow>. Todas las operaciones son idempotentes.
 *
 * `seedStatus(id, row)` — helper de tests: pre-carga una fila sin pasar por setStatus().
 */
export class InMemoryClientTvRegisterStatusRepository implements ClientTvRegisterStatusRepository {
  private readonly store = new Map<string, TvRegisterStatusRow>();

  /** Helper de tests — pre-carga el estado de un cliente. */
  seedStatus(clientId: string, row: TvRegisterStatusRow): void {
    this.store.set(clientId, row);
  }

  async getStatus(clientId: string): Promise<TvRegisterStatusRow | null> {
    return this.store.get(clientId) ?? null;
  }

  async setStatus(clientId: string, row: TvRegisterStatusRow): Promise<void> {
    this.store.set(clientId, row);
  }
}
