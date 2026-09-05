import { prisma } from '@infrastructure/database/prisma';
import type {
  AssistantInvoiceFact,
  AssistantInvoicesReader,
} from '@domain/ports/AssistantInvoicesReader';

/**
 * ai-assistant-cobranzas (4.4 / DAT-2 / D8) — lectura del ESPEJO de facturas para el bot.
 *
 * Tres decisiones, y las tres son de seguridad:
 *
 *  1. **`where.clientId` — el ancla vive acá, no en el caller.** Precedente
 *     `PortalPaymentsReader`: un puerto que devuelve "las facturas" y confía en que el llamador
 *     filtre es un IDOR esperando a que alguien se olvide un parámetro.
 *  2. **`select` explícito, jamás un `include` ni un spread.** `Invoice` tiene `customerName`
 *     (el nombre del titular) y una relación a `Client` entera. Estos hechos van al prompt de
 *     un LLM: SEC-1 no se apoya en `assertFactsArePiiFree` como red, se apoya en no traer el
 *     dato. Agregar un campo acá es una decisión consciente, no un efecto colateral.
 *  3. **Sólo facturas ABIERTAS** (`pendiente`/`vencida`, nunca `pagada`): el bloque de cobranza
 *     con el link de pago de una factura ya paga es exactamente el mensaje que este change
 *     existe para no mandar.
 *
 * NO resuelve staleness ni decide "está al día" — eso es del resolver
 * (`ClienteFacturasResolver`, D7/D8). Este adapter sólo lee lo que ya está espejado.
 */
export class PrismaAssistantInvoicesReader implements AssistantInvoicesReader {
  async listOpenByClientId(clientId: string): Promise<AssistantInvoiceFact[]> {
    const rows = await prisma.invoice.findMany({
      where: { clientId, status: { in: ['pendiente', 'vencida'] } },
      select: {
        number: true,
        grType: true,
        dueDate: true,
        balance: true,
        pdfUrl: true,
        couponPdfUrl: true,
        paymentUrl: true,
      },
      orderBy: { dueDate: 'asc' },
    });

    return rows.map((r) => ({
      // GR no siempre manda el tipo; "Factura" es una etiqueta neutra, nunca un dato inventado.
      tipo: r.grType ?? 'Factura',
      numero: r.number,
      vencimiento: toIso(r.dueDate),
      // `Decimal` no sobrevive a un JSON.stringify hacia el prompt: se convierte acá.
      saldo: toNumber(r.balance),
      pdfUrl: r.pdfUrl ?? null,
      couponPdfUrl: r.couponPdfUrl ?? null,
      paymentUrl: r.paymentUrl ?? null,
    }));
  }

  async findTotalPaymentUrlByClientId(clientId: string): Promise<string | null> {
    const row = await prisma.client.findUnique({
      where: { id: clientId },
      select: { grPaymentUrl: true },
    });
    return row?.grPaymentUrl ?? null;
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
