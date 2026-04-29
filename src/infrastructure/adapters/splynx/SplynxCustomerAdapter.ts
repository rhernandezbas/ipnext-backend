import { CustomerRepository, ListClientsQuery, ListLogsQuery } from '@domain/ports/CustomerRepository';
import { Customer, CustomerStatus, Service, ClientLog } from '@domain/entities/customer';
import { Invoice } from '@domain/entities/billing';
import { PaginatedResult } from '@application/dto/pagination';
import { ClientNotFoundError } from '@domain/errors';
import { SplynxClient } from './SplynxClient';

function mapStatus(splynxStatus: string | number): CustomerStatus {
  const s = String(splynxStatus);
  const map: Record<string, CustomerStatus> = {
    '1': 'active',
    'active': 'active',
    '2': 'blocked',
    'blocked': 'blocked',
    '3': 'inactive',
    'inactive': 'inactive',
    '4': 'late',
    'late': 'late',
  };
  return map[s] ?? 'inactive';
}

interface SplynxCustomer {
  id: string | number;
  name: string;
  email: string;
  phone: string;
  status: string | number;
  street_1?: string;
  city?: string;
  country?: string;
  login?: string;
  date_add?: string;
  [key: string]: unknown;
}

interface SplynxService {
  id: string | number;
  service_type?: string;
  plan?: string;
  ip?: string;
  status?: string;
  start_date?: string;
  end_date?: string;
}

interface SplynxLog {
  id: string | number;
  date?: string;
  type?: string;
  message?: string;
}

export class SplynxCustomerAdapter implements CustomerRepository {
  constructor(private readonly client: SplynxClient) {}

  async list(query: ListClientsQuery): Promise<PaginatedResult<Customer>> {
    const params: Record<string, unknown> = {
      page: query.page,
      itemsPerPage: query.limit,
    };
    if (query.search) params['search'] = query.search;
    if (query.status) params['status'] = query.status;

    const raw = await this.client.get<SplynxCustomer[]>('/api/2.0/admin/customers/customer', params);
    const data = Array.isArray(raw) ? raw : [];
    return {
      data: data.map(this.mapCustomer),
      total: data.length,
      page: query.page ?? 1,
      limit: query.limit ?? 25,
    };
  }

  async findById(id: string): Promise<Customer> {
    const raw = await this.client.get<SplynxCustomer>(`/api/2.0/admin/customers/customer/${id}`);
    if (!raw || !raw.id) throw new ClientNotFoundError(id);
    return this.mapCustomer(raw);
  }

  async listServices(clientId: string): Promise<Service[]> {
    const raw = await this.client.get<SplynxService[]>(
      `/api/2.0/admin/customers/internet-service`,
      { customer_id: clientId }
    );
    const data = Array.isArray(raw) ? raw : [];
    return data.map((s) => ({
      id: String(s.id),
      type: s.service_type ?? 'Internet',
      plan: s.plan ?? '',
      ip: s.ip ?? '',
      status: s.status ?? '',
      startDate: s.start_date ?? '',
      endDate: s.end_date ?? '',
    }));
  }

  async listInvoices(clientId: string): Promise<Invoice[]> {
    const raw = await this.client.get<unknown[]>(
      `/api/2.0/admin/billing/invoice`,
      { customer_id: clientId }
    );
    const data = Array.isArray(raw) ? raw : [];
    return data.map((item) => {
      const inv = item as Record<string, unknown>;
      return {
        id: String(inv['id'] ?? ''),
        number: String(inv['number'] ?? inv['id'] ?? ''),
        customerId: clientId,
        customerName: '',
        issueDate: String(inv['date_created'] ?? inv['date'] ?? ''),
        dueDate: String(inv['payment_due'] ?? ''),
        amount: Number(inv['total'] ?? 0),
        status: mapInvoiceStatus(String(inv['status'] ?? '')),
        lineItems: [] as import('@domain/entities/billing').LineItem[],
      };
    });
  }

  async listLogs(query: ListLogsQuery): Promise<PaginatedResult<ClientLog>> {
    const raw = await this.client.get<SplynxLog[]>(
      `/api/2.0/admin/logs/customer-activity`,
      { customer_id: query.clientId, page: query.page, itemsPerPage: query.limit }
    );
    const data = Array.isArray(raw) ? raw : [];
    return {
      data: data.map((l) => ({
        id: String(l.id),
        timestamp: l.date ?? '',
        eventType: l.type ?? '',
        description: l.message ?? '',
      })),
      total: data.length,
      page: query.page ?? 1,
      limit: query.limit ?? 25,
    };
  }

  private mapCustomer(s: SplynxCustomer): Customer {
    return {
      id: String(s.id),
      name: s.name,
      email: s.email,
      phone: s.phone,
      status: mapStatus(s.status),
      address: s.street_1 ?? '',
      city: s.city ?? '',
      country: s.country ?? '',
      login: s.login ?? '',
      createdAt: s.date_add ?? '',
    };
  }
}

function mapInvoiceStatus(s: string): import('@domain/entities/billing').InvoiceStatus {
  const map: Record<string, import('@domain/entities/billing').InvoiceStatus> = {
    '1': 'pendiente',
    'not_paid': 'pendiente',
    '2': 'pagada',
    'paid': 'pagada',
    '3': 'vencida',
    'overdue': 'vencida',
  };
  return map[s] ?? 'pendiente';
}
