import { GrClient, GrContract } from '../entities/gestionReal';

export interface UpsertResult {
  /** true when a new local row was created, false when an existing one was updated. */
  created: boolean;
}

/**
 * Write side of the GR mirror. Kept separate from CustomerRepository on purpose:
 * the read path (listing/clients UI) is unaffected by GR, and turning the sync
 * off leaves this port simply unused.
 */
export interface ClientMirrorRepository {
  /** Upsert a Client row keyed by grClienteId. */
  upsertClient(client: GrClient): Promise<UpsertResult>;
  /** Upsert a Service row keyed by grContratoId, resolving its parent by grClienteId. */
  upsertContract(contract: GrContract): Promise<UpsertResult>;
}
