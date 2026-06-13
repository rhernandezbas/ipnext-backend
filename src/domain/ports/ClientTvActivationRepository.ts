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
}
