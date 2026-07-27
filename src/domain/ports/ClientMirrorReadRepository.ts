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
  /**
   * finance-growth Fase 3 — batch-resolve the GR client id for a set of
   * LOCAL `Client.id`s. `ContractServiceEvent`/`Contract` only carry the
   * internal `clientId`, while `FinancePaymentReceipt`/`FinanceReceiptItem`/
   * `FinanceReceiptApplication` key cash by `clientGrId` (GR's own id) —
   * this is the ONE join point between the two worlds for the metrics
   * engine (design.md Decision 5: the metrics engine never talks to GR
   * directly, but it still needs this id to read the already-ingested
   * cash). A `clientId` with no `grClienteId` (never mirrored, or mirrored
   * without a GR link) is simply ABSENT from the returned map — never a
   * thrown error — so the caller can count/log it as an attribution orphan
   * (spec.md "un cliente cuyo clientGrId no resuelve... se cuenta y logea,
   * NUNCA aborta el cómputo del mes") instead of crashing the whole
   * snapshot.
   */
  getGrClienteIdsByClientIds(clientIds: string[]): Promise<Map<string, string>>;
}
