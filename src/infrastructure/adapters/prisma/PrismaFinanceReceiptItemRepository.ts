import {
  FinanceReceiptItem,
  FinanceReceiptItemRepository,
} from '@domain/ports/FinanceReceiptItemRepository';
import { yearMonthToDateRange } from '@application/use-cases/finance/financeDates';
import { prisma } from '../../database/prisma';

interface ItemRow {
  grItemId: string;
  receiptId: string;
  banco: string | null;
  cajaCuentaId: string | null;
  destino: string | null;
  fecha: Date | null;
  amount: unknown; // Prisma.Decimal
  moneda: string | null;
  numeroTransferencia: string | null;
  tipo: string | null;
}

function toEntity(row: ItemRow): FinanceReceiptItem {
  return {
    grItemId: row.grItemId,
    receiptId: row.receiptId,
    banco: row.banco,
    cajaCuentaId: row.cajaCuentaId,
    destino: row.destino,
    fecha: row.fecha,
    amount: Number(row.amount),
    moneda: row.moneda,
    numeroTransferencia: row.numeroTransferencia,
    tipo: row.tipo,
  };
}

/**
 * finance-growth Fase 1 (fix-wave-2 R1) — Prisma adapter for
 * `FinanceReceiptItem` (cash actually received). Molde
 * `PrismaFinanceReceiptApplicationRepository` — same one-transaction-per-page
 * upsert idiom, and (fix-wave-3 LOW) the same `listByMonth`/
 * `listByClientAndMonth` read-path shape, so the cash metric has a
 * ready-made read that is at least as easy as summing `aplicaciones` — but
 * (fix-wave-4 W2) cut by the parent receipt's `fechaRecibo`, not this row's
 * own `fecha` (see the per-method docblocks below).
 */
export class PrismaFinanceReceiptItemRepository implements FinanceReceiptItemRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get table(): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (prisma as any).financeReceiptItem;
  }

  /**
   * fix-wave-4 W2 — cuts by `receipt.fechaRecibo` (JOIN), NOT `this.fecha`.
   * Measured live (500 recibos, junio 2026): 56/499 items (10,4% of the
   * cash) have NO `fecha` at all on the wire — those rows read `fecha: null`
   * here and, under the OLD `WHERE fecha BETWEEN ...` cut, disappeared from
   * every month with no error, no warning, nothing reconciliable. The
   * `FinanceReceiptItem_fecha_idx` index (migration `20261023000400`) backs
   * the WRONG column for this query — kept (see that migration's comment)
   * rather than dropped, since `FinancePaymentReceipt.fechaRecibo` already
   * has its own index (`FinancePaymentReceipt_fechaRecibo_idx`) that this
   * JOIN actually uses.
   */
  /** gr-receipt-annulment (design.md Decision 6, spec.md D1) — `receipt.anulado: false` closes deuda #7: without it, marking `anulado` on the ingest side changes nothing on the dashboard. */
  async listByMonth(yearMonth: string): Promise<FinanceReceiptItem[]> {
    const { start, endExclusive } = yearMonthToDateRange(yearMonth);
    const rows: ItemRow[] = await this.table.findMany({
      where: { receipt: { fechaRecibo: { gte: start, lt: endExclusive }, anulado: false } },
    });
    return rows.map(toEntity);
  }

  /** fix-wave-4 W2 — same `receipt.fechaRecibo` cut as `listByMonth`, plus the client join. gr-receipt-annulment (D2) adds `receipt.anulado: false`. */
  async listByClientAndMonth(clientGrId: string, yearMonth: string): Promise<FinanceReceiptItem[]> {
    const { start, endExclusive } = yearMonthToDateRange(yearMonth);
    const rows: ItemRow[] = await this.table.findMany({
      where: {
        receipt: { fechaRecibo: { gte: start, lt: endExclusive }, clientGrId, anulado: false },
      },
    });
    return rows.map(toEntity);
  }

  async upsertBatch(items: FinanceReceiptItem[]): Promise<void> {
    if (items.length === 0) return;
    const ops = items.map((i) =>
      this.table.upsert({
        where: { grItemId: i.grItemId },
        create: {
          grItemId: i.grItemId,
          receiptId: i.receiptId,
          banco: i.banco,
          cajaCuentaId: i.cajaCuentaId,
          destino: i.destino,
          fecha: i.fecha,
          amount: i.amount,
          moneda: i.moneda,
          numeroTransferencia: i.numeroTransferencia,
          tipo: i.tipo,
        },
        update: {
          banco: i.banco,
          cajaCuentaId: i.cajaCuentaId,
          destino: i.destino,
          fecha: i.fecha,
          amount: i.amount,
          moneda: i.moneda,
          numeroTransferencia: i.numeroTransferencia,
          tipo: i.tipo,
        },
      }),
    );
    await prisma.$transaction(ops);
  }
}
