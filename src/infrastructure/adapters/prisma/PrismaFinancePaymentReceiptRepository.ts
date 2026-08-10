import {
  FinancePaymentReceipt,
  FinancePaymentReceiptRepository,
} from '@domain/ports/FinancePaymentReceiptRepository';
import { prisma } from '../../database/prisma';

/**
 * finance-growth Fase 1 — Prisma adapter for `FinancePaymentReceipt`.
 * `upsertBatch` runs the whole page in ONE transaction (molde
 * `PrismaRbacUserRepository`'s array form) so a partial page never persists
 * half-written on a mid-batch failure.
 */
export class PrismaFinancePaymentReceiptRepository implements FinancePaymentReceiptRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get table(): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (prisma as any).financePaymentReceipt;
  }

  async upsertBatch(receipts: FinancePaymentReceipt[]): Promise<void> {
    if (receipts.length === 0) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ops = receipts.map((r) =>
      this.table.upsert({
        where: { grReceiptId: r.grReceiptId },
        create: {
          grReceiptId: r.grReceiptId,
          clientGrId: r.clientGrId,
          recaudador: r.recaudador,
          fechaRecibo: r.fechaRecibo,
          fechaConfirmacion: r.fechaConfirmacion,
          anulado: r.anulado,
          observaciones: r.observaciones,
        },
        update: {
          clientGrId: r.clientGrId,
          recaudador: r.recaudador,
          fechaRecibo: r.fechaRecibo,
          fechaConfirmacion: r.fechaConfirmacion,
          observaciones: r.observaciones,
          // gr-receipt-annulment fix-wave RF1 — ONE-WAY LATCH (see the port's
          // `upsertBatch` docblock for the full rationale). `anulado: true`
          // is written; `false` is OMITTED so an already-annulled row is
          // never silently un-annulled by a GR page that stopped reporting
          // `fecha_anulacion`. Before this fix the field was omitted in BOTH
          // directions — the reconcile lane could not flip anything, which is
          // its entire reason to exist.
          ...(r.anulado ? { anulado: true } : {}),
        },
      }),
    );
    await prisma.$transaction(ops);
  }

  async exists(grReceiptId: string): Promise<boolean> {
    const row = await this.table.findUnique({ where: { grReceiptId }, select: { grReceiptId: true } });
    return !!row;
  }

  async annulmentStateOf(grReceiptIds: string[]): Promise<Map<string, boolean>> {
    if (grReceiptIds.length === 0) return new Map();
    const rows: Array<{ grReceiptId: string; anulado: boolean }> = await this.table.findMany({
      where: { grReceiptId: { in: grReceiptIds } },
      select: { grReceiptId: true, anulado: true },
    });
    return new Map(rows.map((r) => [r.grReceiptId, r.anulado]));
  }

  async existingIds(grReceiptIds: string[]): Promise<Set<string>> {
    if (grReceiptIds.length === 0) return new Set();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: Array<{ grReceiptId: string }> = await this.table.findMany({
      where: { grReceiptId: { in: grReceiptIds } },
      select: { grReceiptId: true },
    });
    return new Set(rows.map((r) => r.grReceiptId));
  }
}
