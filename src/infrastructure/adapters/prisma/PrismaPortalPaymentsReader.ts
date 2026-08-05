import { prisma } from '../../database/prisma';
import type {
  PortalPaymentsReader,
  PortalPaymentReceiptRow,
  PortalPaymentsQuery,
  PortalPaymentsPage,
} from '@domain/ports/PortalPaymentsReader';

/** Prisma devuelve `Decimal`; el DTO no puede llevarlo. */
function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object' && 'toNumber' in v) {
    return (v as { toNumber(): number }).toNumber();
  }
  return Number(v ?? 0);
}

function toIso(d: unknown): string | null {
  return d instanceof Date ? d.toISOString() : null;
}

/**
 * Lectura de recibos para el portal del cliente.
 *
 * ⚠️ **Los dos filtros de seguridad viven ACÁ, en el WHERE, y no en el use case**:
 *   - `clientGrId` — anti-IDOR estructural. El use case ya lo deriva del token, pero
 *     el servidor es la autoridad: si mañana alguien llama a este puerto desde otro
 *     lado, no puede devolver los recibos de un tercero.
 *   - `anulado: false` — el ingest ya excluye las anulaciones reales antes de
 *     persistir, pero si ese criterio cambia, el endpoint cliente-facing no puede
 *     empezar a mostrar pagos anulados en silencio.
 * Los dos con revert-probe (lección `invariante-sin-test-en-el-adapter-real`).
 *
 * Una sola query paginada con `include` — nada de N+1. `FinancePaymentReceipt` ya
 * tiene `@@index([clientGrId, fechaRecibo])`, que cubre exactamente este acceso
 * (filtrar por cliente, ordenar por fecha).
 */
export class PrismaPortalPaymentsReader implements PortalPaymentsReader {
  async listByGrClienteId(
    grClienteId: string,
    query: PortalPaymentsQuery,
  ): Promise<PortalPaymentsPage<PortalPaymentReceiptRow>> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 25;

    const where = { clientGrId: grClienteId, anulado: false };

    const [total, rows] = await Promise.all([
      prisma.financePaymentReceipt.count({ where }),
      prisma.financePaymentReceipt.findMany({
        where,
        // `nulls: 'last'` porque `fechaRecibo` es NULLABLE y en Postgres un
        // `ORDER BY x DESC` pone los NULL PRIMERO: los recibos sin fecha se iban
        // arriba de todo en la página 1. Y desempate por id porque la fecha tiene
        // granularidad de DÍA: sin él, dos recibos del mismo día salen en orden
        // arbitrario entre queries y con `skip/take` uno puede aparecer DUPLICADO
        // en dos páginas mientras otro no sale nunca. Misma convención que
        // `PrismaConversationRepository`.
        orderBy: [{ fechaRecibo: { sort: 'desc', nulls: 'last' } }, { grReceiptId: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: { items: true, applications: true, retenciones: true },
      }),
    ]);

    const data: PortalPaymentReceiptRow[] = (rows as unknown as Array<Record<string, unknown>>).map(
      (r) => ({
        grReceiptId: String(r.grReceiptId),
        fechaRecibo: toIso(r.fechaRecibo),
        recaudador: (r.recaudador as string | null) ?? null,
        items: ((r.items as Array<Record<string, unknown>>) ?? []).map((i) => ({
          amount: toNumber(i.amount),
          moneda: (i.moneda as string | null) ?? null,
        })),
        retenciones: ((r.retenciones as Array<Record<string, unknown>>) ?? []).map((t) => ({
          amount: toNumber(t.amount),
        })),
        applications: ((r.applications as Array<Record<string, unknown>>) ?? []).map((a) => ({
          grInvoiceId: String(a.grInvoiceId),
          grType: String(a.grType),
          amount: toNumber(a.amount),
        })),
      }),
    );

    return { data, total, page, limit };
  }
}
