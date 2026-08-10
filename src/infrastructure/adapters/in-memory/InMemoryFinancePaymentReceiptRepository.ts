import {
  FinancePaymentReceipt,
  FinancePaymentReceiptRepository,
} from '@domain/ports/FinancePaymentReceiptRepository';

export class InMemoryFinancePaymentReceiptRepository implements FinancePaymentReceiptRepository {
  rows = new Map<string, FinancePaymentReceipt>();

  /**
   * gr-receipt-annulment fix-wave RF1 — replicates
   * `PrismaFinancePaymentReceiptRepository.upsertBatch` FIELD BY FIELD,
   * including the one-way `anulado` latch. This used to be a whole-row
   * `rows.set(...)` replacement — strictly more permissive than the SQL that
   * actually runs, so every use-case/seam test that touches an already-mirrored
   * receipt was certifying semantics production does not have. Any field added
   * to the Prisma `update` block must be added here too.
   */
  async upsertBatch(receipts: FinancePaymentReceipt[]): Promise<void> {
    for (const r of receipts) {
      const prior = this.rows.get(r.grReceiptId);
      if (!prior) {
        this.rows.set(r.grReceiptId, { ...r });
        continue;
      }
      this.rows.set(r.grReceiptId, {
        grReceiptId: prior.grReceiptId,
        clientGrId: r.clientGrId,
        recaudador: r.recaudador,
        fechaRecibo: r.fechaRecibo,
        fechaConfirmacion: r.fechaConfirmacion,
        observaciones: r.observaciones,
        // LATCH: true wins, false never un-annuls.
        anulado: prior.anulado || r.anulado,
      });
    }
  }

  async exists(grReceiptId: string): Promise<boolean> {
    return this.rows.has(grReceiptId);
  }

  async annulmentStateOf(grReceiptIds: string[]): Promise<Map<string, boolean>> {
    const out = new Map<string, boolean>();
    for (const id of grReceiptIds) {
      const row = this.rows.get(id);
      if (row) out.set(id, row.anulado);
    }
    return out;
  }

  async existingIds(grReceiptIds: string[]): Promise<Set<string>> {
    return new Set(grReceiptIds.filter((id) => this.rows.has(id)));
  }
}
