import type { ClientTvRegisterStatusRepository, TvRegisterStatusRow } from '@domain/ports/ClientTvRegisterStatusRepository';
import { isTvRegisterJobActive } from '@domain/gigared/tvRegisterJob';

/**
 * Adapter in-memory de ClientTvRegisterStatusRepository (gigared-alta-asincrona W1.2).
 * Map<clientId, TvRegisterStatusRow>.
 *
 * ⚠️ `tryReserve` y `compareAndSet` NO pueden tener un `await` entre la condición y la escritura.
 * Ese yield es exactamente el TOCTOU que el port existe para cerrar: con él, los tests de
 * concurrencia pasarían acá y el race quedaría vivo sólo en producción. Como JS es monohilo, un
 * bloque síncrono es la contraparte fiel del `UPDATE … WHERE` de Postgres.
 *
 * `seedStatus(id, row)` — helper de tests: pre-carga una fila SIN pasar por la reserva.
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

  async tryReserve(clientId: string, startedAt: Date, ttlMs: number): Promise<boolean> {
    // ── bloque ATÓMICO: ni un solo await hasta el set ──────────────────────────
    const actual = this.store.get(clientId) ?? null;
    if (isTvRegisterJobActive(actual, startedAt, ttlMs)) return false;
    // El `result` del intento anterior se DESCARTA: si sobreviviera, el polling del alta nueva
    // mostraría el error de la vieja.
    this.store.set(clientId, { status: 'pending', startedAt, heartbeatAt: startedAt });
    return true;
    // ──────────────────────────────────────────────────────────────────────────
  }

  async compareAndSet(clientId: string, expectedHeartbeatAt: Date, row: TvRegisterStatusRow): Promise<boolean> {
    // ── bloque ATÓMICO ────────────────────────────────────────────────────────
    const actual = this.store.get(clientId);
    if (!actual) return false;
    if (actual.heartbeatAt?.getTime() !== expectedHeartbeatAt.getTime()) return false;
    this.store.set(clientId, row);
    return true;
    // ──────────────────────────────────────────────────────────────────────────
  }
}
