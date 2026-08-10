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
   * Mirror the client's GR invoices into the local `Invoice` table (replace-all,
   * scoped to `grInvoiceId IS NOT NULL`): in a transaction, delete the client's
   * GR-sourced invoices that GR no longer returns, then upsert each current one by
   * its composite `grInvoiceId`. Manual invoices (`grInvoiceId = null`) are NEVER
   * touched. Status is DERIVED from saldo + due date at `at`. No-op when the client
   * (grClienteId) is not found locally.
   */
  upsertInvoices(grClienteId: string, invoices: GrInvoice[], at: Date): Promise<void>;
  /**
   * fix wave F3 — escribe el saldo Y (opcionalmente) el espejo de facturas en
   * UNA SOLA transacción. **Es la ÚNICA forma de escribir el saldo.**
   *
   * Existe porque hacerlo en dos llamadas era no-atómico de una forma silenciosa:
   * la escritura suelta del saldo commiteaba, y si `upsertInvoices` fallaba
   * después, la base quedaba con saldo NUEVO y facturas VIEJAS mientras el caller
   * recibía "no se refrescó nada". Encima el `lastBalanceAt` fresco tapaba la
   * inconsistencia: nadie la ve stale, nadie la vuelve a pedir.
   *
   * fix wave 2 (FW2-4) — por eso el camino viejo (`updateClientBalance`, saldo
   * suelto) se ELIMINÓ del puerto y de los dos adapters en vez de dejarlo sin
   * callers. Un método publicado en un port no es código muerto: es una oferta, y
   * el próximo que necesite "sólo el saldo" lo habría encontrado documentado y
   * con tests verdes. Para escribir el saldo sin tocar facturas: `invoices: null`.
   *
   * `invoices: null` ⇒ el payload NO es autoritativo sobre facturas (deuda
   * reportada pero lista vacía: schema drift / payload parcial) y el espejo de
   * facturas NO se toca — sólo se escribe el saldo. La decisión de autoridad es
   * del use case; el puerto sólo la ejecuta.
   */
  updateBalanceAndInvoices(params: UpdateBalanceAndInvoicesParams): Promise<void>;
}

export interface UpdateBalanceAndInvoicesParams {
  grClienteId: string;
  amount: number;
  currency: string | null;
  /** `null` ⇒ no tocar el espejo de facturas (payload no autoritativo). */
  invoices: GrInvoice[] | null;
  at: Date;
}
