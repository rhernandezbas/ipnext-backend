export interface MirrorCountsRepository {
  /** Number of Client rows with grClienteId NOT null (mirrored from GR). */
  clientCount(): Promise<number>;
  /** Number of Service rows with grContratoId NOT null (mirrored from GR). */
  contractCount(): Promise<number>;
}
