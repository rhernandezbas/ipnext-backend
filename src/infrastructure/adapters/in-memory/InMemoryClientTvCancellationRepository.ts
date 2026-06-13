import type { ClientTvCancellationRepository } from '@domain/ports/ClientTvCancellationRepository';

/**
 * In-memory adapter para ClientTvCancellationRepository (#72).
 * Usa un Set de ids marcados. Todas las operaciones son idempotentes.
 *
 * `seedCancelled(id)` — helper para tests: pre-seed el flag sin pasar por markCancelled().
 */
export class InMemoryClientTvCancellationRepository implements ClientTvCancellationRepository {
  private readonly cancelled = new Set<string>();

  /** Test helper — pre-marca un id como cancelado sin pasar por markCancelled(). */
  seedCancelled(clientId: string): void {
    this.cancelled.add(clientId);
  }

  async markCancelled(clientId: string): Promise<void> {
    this.cancelled.add(clientId);
  }

  async clearCancelled(clientId: string): Promise<void> {
    this.cancelled.delete(clientId);
  }

  async isCancelled(clientId: string): Promise<boolean> {
    return this.cancelled.has(clientId);
  }
}
