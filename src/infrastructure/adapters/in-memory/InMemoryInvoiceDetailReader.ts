import type { InvoiceDetailInvoice, InvoiceDetailReader } from '@domain/ports/InvoiceDetailReader';

/**
 * whatsapp-invoice-detail-quickreply (Phase 3) — test double del port,
 * seedeable por `clientId` en el ctor. Puede simular una falla de GR
 * (`failForClientId`) para ejercitar el fallback QR-4 sin mockear nada real.
 */
export interface InMemoryInvoiceDetailReaderOptions {
  invoicesByClientId?: Record<string, InvoiceDetailInvoice[]>;
  /** Cualquier `listOpenByClientId` a este clientId lanza (simula GR/DB caído). */
  failForClientId?: string;
}

export class InMemoryInvoiceDetailReader implements InvoiceDetailReader {
  private readonly invoicesByClientId: Record<string, InvoiceDetailInvoice[]>;
  private readonly failForClientId?: string;

  constructor(opts: InMemoryInvoiceDetailReaderOptions = {}) {
    this.invoicesByClientId = opts.invoicesByClientId ?? {};
    this.failForClientId = opts.failForClientId;
  }

  async listOpenByClientId(clientId: string): Promise<InvoiceDetailInvoice[]> {
    if (this.failForClientId !== undefined && clientId === this.failForClientId) {
      throw new Error(`InMemoryInvoiceDetailReader: simulated failure for ${clientId}`);
    }
    return (this.invoicesByClientId[clientId] ?? []).map((inv) => ({ ...inv }));
  }
}
