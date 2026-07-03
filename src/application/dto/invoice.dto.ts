import { Invoice } from '@domain/entities/billing';

/**
 * Stable read contract for `GET /clients/:id/invoices`. The FE consumes this
 * shape verbatim (mirrored field-for-field in the FE's `types/billing.ts`).
 * Deliberately EXCLUDES domain-only noise (`lineItems`, `customerId`,
 * `customerName`, `grInvoiceId`) — see design AD-6.
 */
export interface InvoiceDto {
  id: string;
  number: string;
  grType: string | null;
  amount: number;
  balance: number;
  currency: string | null;
  status: 'pagada' | 'pendiente' | 'vencida';
  issueDate: string; // ISO
  dueDate: string; // ISO
  pdfUrl: string | null;
  couponPdfUrl: string | null;
  paymentUrl: string | null;
}

/**
 * Map a domain Invoice to the FE-facing DTO. `balance` falls back to `amount`
 * when null (non-GR/manual rows carry no separate saldo → treat as fully due).
 * In practice every synced GR invoice has a concrete balance.
 */
export function toInvoiceDto(inv: Invoice): InvoiceDto {
  return {
    id: inv.id,
    number: inv.number,
    grType: inv.grType,
    amount: inv.amount,
    balance: inv.balance ?? inv.amount,
    currency: inv.currency,
    status: inv.status,
    issueDate: inv.issueDate,
    dueDate: inv.dueDate,
    pdfUrl: inv.pdfUrl,
    couponPdfUrl: inv.couponPdfUrl,
    paymentUrl: inv.paymentUrl,
  };
}
