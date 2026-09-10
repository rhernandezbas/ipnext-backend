import { prisma } from '@infrastructure/database/prisma';
import type { InvoiceDetailInvoice, InvoiceDetailReader } from '@domain/ports/InvoiceDetailReader';

/**
 * whatsapp-invoice-detail-quickreply (Phase 3, QR-2/QR-3) — lectura del espejo
 * de facturas (`Invoice`, la MISMA tabla Prisma que alimenta el resto del
 * sistema) para el quick-reply de detalle.
 *
 * QR-2 (aislamiento total) — archivo NUEVO, CERO import desde `assistant/*`.
 * Deliberadamente paralelo a `PrismaAssistantInvoicesReader` (mismo criterio:
 * `where.clientId` en el adapter, `select` explícito sin identidad, solo
 * `pendiente`/`vencida`) pero SIN `couponPdfUrl` (design "no post-due line in
 * v1" — esta feature solo muestra "Ver" y "Pagar ahora").
 */
export class PrismaInvoiceDetailReader implements InvoiceDetailReader {
  async listOpenByClientId(clientId: string): Promise<InvoiceDetailInvoice[]> {
    const rows = await prisma.invoice.findMany({
      where: { clientId, status: { in: ['pendiente', 'vencida'] } },
      select: {
        number: true,
        grType: true,
        dueDate: true,
        balance: true,
        pdfUrl: true,
        paymentUrl: true,
      },
      orderBy: { dueDate: 'asc' },
    });

    return rows.map((r) => ({
      tipo: r.grType ?? 'Factura',
      numero: r.number,
      vencimiento: toIso(r.dueDate),
      saldo: toNumber(r.balance),
      pdfUrl: r.pdfUrl ?? null,
      paymentUrl: r.paymentUrl ?? null,
    }));
  }
}

function toIso(d: Date | string | null | undefined): string {
  if (!d) return '';
  return d instanceof Date ? d.toISOString() : String(d);
}

/** `Decimal | number | null` → número plano. `null` (fila manual sin saldo) ⇒ 0. */
function toNumber(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  const withToNumber = v as { toNumber?: () => number };
  return typeof withToNumber.toNumber === 'function' ? withToNumber.toNumber() : Number(v);
}
