import type { ClientTvActivationRepository } from '@domain/ports/ClientTvActivationRepository';

/**
 * In-memory adapter para ClientTvActivationRepository (#81).
 * Mantiene un Map<clientId, seq>. Todas las operaciones son idempotentes salvo incrementSeq.
 *
 * `seedSeq(id, seq)` — helper para tests: pre-setea el contador sin pasar por incrementSeq().
 */
export class InMemoryClientTvActivationRepository implements ClientTvActivationRepository {
  private readonly seqs = new Map<string, number>();

  /** Test helper — pre-setea el seq de un cliente. */
  seedSeq(clientId: string, seq: number): void {
    this.seqs.set(clientId, seq);
  }

  async getSeq(clientId: string): Promise<number> {
    return this.seqs.get(clientId) ?? 0;
  }

  async incrementSeq(clientId: string): Promise<number> {
    const next = (this.seqs.get(clientId) ?? 0) + 1;
    this.seqs.set(clientId, next);
    return next;
  }

  /** F1 — sube el seq a `n` sólo si el almacenado es menor (nunca retrocede). Idempotente. */
  async ensureSeqAtLeast(clientId: string, n: number): Promise<void> {
    const current = this.seqs.get(clientId) ?? 0;
    if (n > current) this.seqs.set(clientId, n);
  }
}
