/**
 * PortalInvoiceDto — customer-portal-api (Fase 4, task 4.2).
 *
 * portal-self-service spec "Mis facturas": allow-list exacto del spec. NUNCA
 * `lineItems`/`grInvoiceId`/campos internos de `Invoice` (domain/entities/billing.ts).
 */
export interface PortalInvoiceDto {
  number: string;
  issueDate: string;
  dueDate: string;
  amount: number;
  balance: number | null;
  status: string;
  pdfUrl: string | null;
  paymentUrl: string | null;
}
