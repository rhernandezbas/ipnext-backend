export type InvoiceStatus = 'pagada' | 'pendiente' | 'vencida';

export interface LineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

export interface Invoice {
  id: string;
  number: string;
  customerId: string;
  customerName: string;
  issueDate: string;
  dueDate: string;
  amount: number;
  status: InvoiceStatus;
  lineItems: LineItem[];
}

export interface Payment {
  id: string;
  number: string;
  customerId: string;
  customerName: string;
  date: string;
  amount: number;
  method: string;
  invoiceId?: string;
}

export type TransactionType = 'cargo' | 'credito';

export interface Transaction {
  id: string;
  customerId: string;
  customerName: string;
  type: TransactionType;
  amount: number;
  date: string;
  description: string;
}

export interface MonthlyBillingData {
  period: string;
  label: string;
  invoiced: number;
  paid: number;
}

export interface MonthlyBillingResponse {
  lastMonth: MonthlyBillingData;
  currentMonth: MonthlyBillingData;
  nextMonth: MonthlyBillingData;
}

export interface BillingSummary {
  totalRevenueThisMonth: number;
  totalPending: number;
  totalOverdue: number;
  creditNotesAmount: number;
  proformaPaidAmount: number;
  proformaUnpaidAmount: number;
}

export type CreditNoteStatus = 'draft' | 'sent' | 'applied' | 'voided';

export interface CreditNote {
  id: string;
  number: string;
  clientId: string;
  clientName: string;
  amount: number;
  taxAmount: number;
  totalAmount: number;
  reason: string;
  relatedInvoiceId: string | null;
  status: CreditNoteStatus;
  issuedAt: string;
  appliedAt: string | null;
  notes: string;
}

export type ProformaStatus = 'draft' | 'sent' | 'paid' | 'cancelled' | 'expired';

export interface ProformaInvoice {
  id: string;
  number: string;
  clientId: string;
  clientName: string;
  items: { description: string; quantity: number; unitPrice: number; total: number }[];
  subtotal: number;
  taxAmount: number;
  total: number;
  status: ProformaStatus;
  issuedAt: string;
  validUntil: string;
  convertedToInvoiceId: string | null;
  notes: string;
}
