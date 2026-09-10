/**
 * whatsapp-invoice-detail-quickreply (Phase 3, QR-2/QR-3, design "Interfaces /
 * Contracts") — hechos de factura para el quick-reply de detalle. Molde
 * DELIBERADAMENTE paralelo a `AssistantInvoicesReader` (mismo ancla-por-cliente,
 * mismo `select` explícito, mismas dos statuses abiertas) pero un archivo NUEVO
 * e INDEPENDIENTE — QR-2 prohíbe cualquier import desde `assistant/*`.
 *
 * Sin `couponPdfUrl` a propósito (design "no 'pagar luego del vencimiento' line
 * in v1"): esta feature solo muestra "Ver" (`pdfUrl`) y "Pagar ahora"
 * (`paymentUrl`).
 */
export interface InvoiceDetailInvoice {
  tipo: string;
  numero: string;
  /** ISO date. */
  vencimiento: string;
  saldo: number;
  pdfUrl: string | null;
  paymentUrl: string | null;
}

/**
 * Puerto ANGOSTO anclado al CLIENTE (mismo precedente que `AssistantInvoicesReader`
 * / `PortalPaymentsReader`): el anclaje por `clientId` vive en el ADAPTER, no en
 * el caller. El `select` de la implementación real NUNCA debe proyectar
 * `customerName` ni ningún campo de identidad — solo lo que esta feature cita.
 */
export interface InvoiceDetailReader {
  listOpenByClientId(clientId: string): Promise<InvoiceDetailInvoice[]>;
}
