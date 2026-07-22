/**
 * #81 — port del contador de reactivaciones de TV POR CLIENTE.
 *
 * El seq vive a nivel Client (lo comparten los N contratos del cliente). Se incrementa SOLO en
 * re-alta (RegisterGigaredAccount sobre un cliente que venía de baja) para mintear un internal_id
 * y un mail frescos, nunca quemados en el partner. GR sync NUNCA escribe esta columna: es estado
 * local del mirror.
 */
export interface ClientTvActivationRepository {
  /** El seq actual del cliente (0 cuando nunca reactivó). */
  getSeq(clientId: string): Promise<number>;
  /** Incrementa el seq de forma atómica y devuelve el NUEVO valor. */
  incrementSeq(clientId: string): Promise<number>;
  /**
   * gigared-tv-identity-hardening (F1) — avance DIFERIDO del seq: lo lleva AL MENOS a `n`
   * (nunca lo retrocede si el almacenado ya es >= n). Idempotente. Se persiste recién tras
   * verificar la identidad en el partner (register+stamp+verify OK), no antes del intento —
   * así los retries recomputan el MISMO candidato (candidato = getSeq()+1) y convergen sin
   * re-registrar. GR sync NUNCA escribe esta columna.
   */
  ensureSeqAtLeast(clientId: string, n: number): Promise<void>;
}
