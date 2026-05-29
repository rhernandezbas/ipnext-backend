/**
 * Read-side port for resolving local FKs from Gestión Real upstream ids.
 *
 * The GR mirror (write-side) lives in ClientMirrorRepository by design; this
 * port is the read counterpart used by the installation-order ingest to map a
 * GR client/contract id to its already-mirrored local Client/Service. A miss
 * (the entity was never mirrored) returns `null` so callers can skip+count it
 * without throwing.
 */
export interface GrLinkResolverPort {
  /** Resolve a local Client by its GR client id. Null when not mirrored. */
  findClientByGrId(grClienteId: string): Promise<{ id: string; name: string } | null>;
  /** Resolve a local Service by its GR contract id. Null when not mirrored. */
  findServiceByGrContratoId(grContratoId: string): Promise<{ id: string; plan: string | null } | null>;
}
