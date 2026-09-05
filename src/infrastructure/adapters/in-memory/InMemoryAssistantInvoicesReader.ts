import type {
  AssistantInvoiceFact,
  AssistantInvoicesReader,
} from '@domain/ports/AssistantInvoicesReader';

/**
 * ai-assistant-cobranzas (4.1 / DAT-2 / D8) — gemelo in-memory de `AssistantInvoicesReader`.
 *
 * ⚠️ El twin replica la SEMÁNTICA del adapter Prisma campo a campo, no una versión cómoda:
 *   - el filtro por `clientId` vive ACÁ, igual que el `where` del real (un caller no puede
 *     "olvidarse" el ancla y ver las facturas de otro cliente);
 *   - la proyección devuelve EXACTAMENTE los 7 campos de `AssistantInvoiceFact`, construidos
 *     campo por campo. Un `{...row}` acá haría pasar en verde un test de PII que en producción
 *     estaría filtrando `customerName`.
 *
 * `seed` recibe hechos YA proyectados: el twin no simula el mapeo de la fila de `Invoice` (eso
 * es responsabilidad del adapter Prisma y de su propio test), simula el CONTRATO del puerto.
 */
export class InMemoryAssistantInvoicesReader implements AssistantInvoicesReader {
  private readonly byClient = new Map<string, AssistantInvoiceFact[]>();
  private readonly totalPaymentUrlByClient = new Map<string, string | null>();

  /** Carga (reemplazando) las facturas abiertas de un cliente. */
  seed(clientId: string, invoices: AssistantInvoiceFact[]): void {
    this.byClient.set(clientId, invoices);
  }

  /** Carga el link "pagar todo junto" (`Client.grPaymentUrl`) de un cliente. */
  seedTotalPaymentUrl(clientId: string, url: string | null): void {
    this.totalPaymentUrlByClient.set(clientId, url);
  }

  async findTotalPaymentUrlByClientId(clientId: string): Promise<string | null> {
    return this.totalPaymentUrlByClient.get(clientId) ?? null;
  }

  async listOpenByClientId(clientId: string): Promise<AssistantInvoiceFact[]> {
    const rows = this.byClient.get(clientId) ?? [];
    // Proyección explícita, campo por campo — mismo criterio que el SELECT del adapter real.
    return rows.map((r) => ({
      tipo: r.tipo,
      numero: r.numero,
      vencimiento: r.vencimiento,
      saldo: r.saldo,
      pdfUrl: r.pdfUrl,
      couponPdfUrl: r.couponPdfUrl,
      paymentUrl: r.paymentUrl,
    }));
  }
}
