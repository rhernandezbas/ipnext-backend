import { BillingRepository, ListInvoicesQuery, ListTransactionsQuery } from '@domain/ports/BillingRepository';
import { BillingSummary, Invoice, Payment, Transaction, InvoiceStatus } from '@domain/entities/billing';
import { PaginatedResult, PaginatedQuery } from '@application/dto/pagination';
import { SplynxClient } from './SplynxClient';

function mapInvoiceStatus(s: string): InvoiceStatus {
  const map: Record<string, InvoiceStatus> = { '1': 'pendiente', 'not_paid': 'pendiente', '2': 'pagada', 'paid': 'pagada', '3': 'vencida', 'overdue': 'vencida' };
  return map[s] ?? 'pendiente';
}

export class SplynxBillingAdapter implements BillingRepository {
  constructor(private readonly client: SplynxClient) {}

  async getSummary(): Promise<BillingSummary> {
    const invoices = await this.client.get<Record<string, unknown>[]>('/api/2.0/admin/billing/invoice', { itemsPerPage: 1000 });
    const data = Array.isArray(invoices) ? invoices : [];
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const thisMonth = data.filter((i) => String(i['date_created'] ?? '') >= monthStart);
    const paidThisMonth = thisMonth.filter((i) => mapInvoiceStatus(String(i['status'] ?? '')) === 'pagada');
    const pending = data.filter((i) => mapInvoiceStatus(String(i['status'] ?? '')) === 'pendiente');
    const overdue = data.filter((i) => mapInvoiceStatus(String(i['status'] ?? '')) === 'vencida');

    return {
      totalRevenueThisMonth: paidThisMonth.reduce((sum, i) => sum + Number(i['total'] ?? 0), 0),
      totalPending: pending.reduce((sum, i) => sum + Number(i['total'] ?? 0), 0),
      totalOverdue: overdue.reduce((sum, i) => sum + Number(i['total'] ?? 0), 0),
      creditNotesAmount: 0,
      proformaPaidAmount: 0,
      proformaUnpaidAmount: 0,
    };
  }

  async listInvoices(query: ListInvoicesQuery): Promise<PaginatedResult<Invoice>> {
    const params: Record<string, unknown> = { page: query.page, itemsPerPage: query.limit };
    if (query.status) params['status'] = query.status;
    if (query.dateFrom) params['date_from'] = query.dateFrom;
    if (query.dateTo) params['date_to'] = query.dateTo;

    const raw = await this.client.get<Record<string, unknown>[]>('/api/2.0/admin/billing/invoice', params);
    let data = Array.isArray(raw) ? raw : [];
    if (query.search) {
      const s = query.search.toLowerCase();
      data = data.filter(
        (inv) =>
          String(inv['customer_name'] ?? '').toLowerCase().includes(s) ||
          String(inv['number'] ?? inv['id'] ?? '').toLowerCase().includes(s),
      );
    }
    return {
      data: data.map((inv) => ({
        id: String(inv['id'] ?? ''),
        number: String(inv['number'] ?? inv['id'] ?? ''),
        customerId: String(inv['customer_id'] ?? ''),
        customerName: String(inv['customer_name'] ?? ''),
        issueDate: String(inv['date_created'] ?? ''),
        dueDate: String(inv['payment_due'] ?? ''),
        amount: Number(inv['total'] ?? 0),
        status: mapInvoiceStatus(String(inv['status'] ?? '')),
        lineItems: [],
      })),
      total: data.length,
      page: query.page ?? 1,
      limit: query.limit ?? 25,
    };
  }

  async listPayments(query: PaginatedQuery & { search?: string }): Promise<PaginatedResult<Payment>> {
    const params: Record<string, unknown> = { page: query.page, itemsPerPage: query.limit };
    if (query.search) params['search'] = query.search;

    const raw = await this.client.get<Record<string, unknown>[]>('/api/2.0/admin/billing/payment', params);
    const data = Array.isArray(raw) ? raw : [];
    return {
      data: data.map((p) => ({
        id: String(p['id'] ?? ''),
        number: String(p['payment_id'] ?? p['id'] ?? ''),
        customerId: String(p['customer_id'] ?? ''),
        customerName: String(p['customer_name'] ?? ''),
        date: String(p['date'] ?? ''),
        amount: Number(p['sum'] ?? 0),
        method: String(p['type'] ?? ''),
        invoiceId: p['invoice_id'] ? String(p['invoice_id']) : undefined,
      })),
      total: data.length,
      page: query.page ?? 1,
      limit: query.limit ?? 25,
    };
  }

  async listTransactions(query: ListTransactionsQuery): Promise<PaginatedResult<Transaction>> {
    const params: Record<string, unknown> = { page: query.page, itemsPerPage: query.limit };
    if (query.dateFrom) params['date_from'] = query.dateFrom;
    if (query.dateTo) params['date_to'] = query.dateTo;

    const raw = await this.client.get<Record<string, unknown>[]>('/api/2.0/admin/billing/transaction', params);
    const data = Array.isArray(raw) ? raw : [];
    return {
      data: data.map((t) => ({
        id: String(t['id'] ?? ''),
        customerId: String(t['customer_id'] ?? ''),
        customerName: String(t['customer_name'] ?? ''),
        type: Number(t['debit'] ?? 0) > 0 ? 'cargo' : 'credito',
        amount: Math.abs(Number(t['debit'] ?? t['credit'] ?? 0)),
        date: String(t['date'] ?? ''),
        description: String(t['comment'] ?? ''),
      })),
      total: data.length,
      page: query.page ?? 1,
      limit: query.limit ?? 25,
    };
  }
}
