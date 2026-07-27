import {
  FinanceReceiptRetencion,
  FinanceReceiptRetencionRepository,
} from '@domain/ports/FinanceReceiptRetencionRepository';
import { prisma } from '../../database/prisma';

/**
 * finance-growth Fase 1 (fix-wave-2 R1) — Prisma adapter for
 * `FinanceReceiptRetencion` (tax-withholding certificates, never cash). Molde
 * `PrismaFinanceReceiptApplicationRepository`.
 */
export class PrismaFinanceReceiptRetencionRepository implements FinanceReceiptRetencionRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get table(): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (prisma as any).financeReceiptRetencion;
  }

  async upsertBatch(retenciones: FinanceReceiptRetencion[]): Promise<void> {
    if (retenciones.length === 0) return;
    const ops = retenciones.map((r) =>
      this.table.upsert({
        where: { grRetencionId: r.grRetencionId },
        create: {
          grRetencionId: r.grRetencionId,
          receiptId: r.receiptId,
          tipo: r.tipo,
          amount: r.amount,
          fecha: r.fecha,
        },
        update: {
          tipo: r.tipo,
          amount: r.amount,
          fecha: r.fecha,
        },
      }),
    );
    await prisma.$transaction(ops);
  }
}
