import { GrClient, GrContract, GrInvoice } from '../entities/gestionReal';

export interface UpsertResult {
  /** true when a new local row was created, false when an existing one was updated. */
  created: boolean;
  /**
   * true when the upsert was skipped due to a missing parent (orphan guard).
   * Only set by `upsertContract` when `created` is false for this reason.
   * Optional so existing callers (backfill, per-client sync) don't break.
   */
  skipped?: boolean;
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
  /**
   * Update ONLY the balance fields on a Client (by grClienteId).
   * MUST NOT touch customAttributes, status, or any other catalog field.
   * No-op when grClienteId is not found.
   */
  updateClientBalance(grClienteId: string, amount: number, currency: string | null, at: Date): Promise<void>;
  /**
   * Mirror the client's GR invoices into the local `Invoice` table (replace-all,
   * scoped to `grInvoiceId IS NOT NULL`): in a transaction, delete the client's
   * GR-sourced invoices that GR no longer returns, then upsert each current one by
   * its composite `grInvoiceId`. Manual invoices (`grInvoiceId = null`) are NEVER
   * touched. Status is DERIVED from saldo + due date at `at`. No-op when the client
   * (grClienteId) is not found locally.
   */
  upsertInvoices(grClienteId: string, invoices: GrInvoice[], at: Date): Promise<void>;
}
