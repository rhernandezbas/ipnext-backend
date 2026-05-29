/**
 * Read-only enumeration port over the local client mirror.
 *
 * Segregated (ISP) from `MirrorCountsRepository` (cardinality: how many) and
 * from the write `ClientMirrorRepository` (upsert/update). A consumer injected
 * with only this port is structurally incapable of mutating the mirror.
 */
export interface ClientMirrorReadRepository {
  /** All grClienteId values present in the local mirror (Client.grClienteId NOT null). */
  listGrClienteIds(): Promise<string[]>;
}
