import type { TvCicReuseEligibilityRepository } from '@domain/ports/TvCicReuseEligibilityRepository';

/**
 * In-memory adapter de TvCicReuseEligibilityRepository (tests de use case).
 *
 * Modela las tres condiciones de la invariante de forma explícita para que un test pueda
 * construir cada estado por separado — incluido el DRIFT (flag de baja puesto + fila de TV
 * viva), que es exactamente el caso que la condición 3 existe para atrapar.
 */
export class InMemoryTvCicReuseEligibilityRepository implements TvCicReuseEligibilityRepository {
  private readonly clients = new Map<string, { cancelled: boolean; hasActiveTvRow: boolean }>();

  /** Alta/actualización del estado de un cliente. Un cliente NO sembrado no existe. */
  seed(clientId: string, state: { cancelled: boolean; hasActiveTvRow: boolean }): void {
    this.clients.set(clientId, { ...state });
  }

  async isEligibleForCicReuse(clientId: string): Promise<boolean> {
    const c = this.clients.get(clientId);
    if (!c) return false; // 1. no existe
    if (!c.cancelled) return false; // 2. sin baja de TV local
    if (c.hasActiveTvRow) return false; // 3. drift: fila de TV todavía activa
    return true;
  }
}
