import { CustomerRepository, ListClientsQuery, ListLogsQuery, CreateCustomerInput, ClientStats } from '@domain/ports/CustomerRepository';
import { Customer, CustomerStatus, Service, ClientLog } from '@domain/entities/customer';
import { Invoice, InvoiceStatus, LineItem } from '@domain/entities/billing';
import { PaginatedResult } from '@application/dto/pagination';
import { ClientNotFoundError } from '@domain/errors';
import { prisma } from '../../database/prisma';

export function toCustomer(row: any): Customer {
  return {
    id: row.id,
    grClienteId: row.grClienteId ?? null,
    name: row.name,
    email: row.email,
    phone: row.phone,
    status: row.status as CustomerStatus,
    address: row.address ?? '',
    city: row.city ?? '',
    country: row.country ?? '',
    login: row.login,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    customAttributes: row.customAttributes ?? undefined,
  };
}

export function toService(row: any): Service {
  return {
    id: row.id,
    type: row.type,
    plan: row.plan,
    ip: row.ip ?? '',
    status: row.status,
    startDate: row.startDate instanceof Date ? row.startDate.toISOString() : row.startDate,
    endDate: row.endDate
      ? (row.endDate instanceof Date ? row.endDate.toISOString() : row.endDate)
      : '',
  };
}

export function toClientLog(row: any): ClientLog {
  return {
    id: row.id,
    timestamp: row.timestamp instanceof Date ? row.timestamp.toISOString() : row.timestamp,
    eventType: row.eventType,
    description: row.description,
  };
}

export function toInvoice(row: any): Invoice {
  const lineItems: LineItem[] = Array.isArray(row.lineItems) ? row.lineItems as LineItem[] : [];
  return {
    id: row.id,
    number: row.number,
    customerId: row.clientId,
    customerName: row.customerName,
    issueDate: row.issueDate instanceof Date ? row.issueDate.toISOString() : row.issueDate,
    dueDate: row.dueDate instanceof Date ? row.dueDate.toISOString() : row.dueDate,
    amount: typeof row.amount === 'object' && row.amount !== null && 'toNumber' in row.amount
      ? (row.amount as { toNumber(): number }).toNumber()
      : Number(row.amount),
    status: row.status as InvoiceStatus,
    lineItems,
  };
}

export class PrismaCustomerRepository implements CustomerRepository {
  async list(query: ListClientsQuery): Promise<PaginatedResult<Customer>> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 25;
    const where: Record<string, unknown> = {};
    if (query.status) where['status'] = query.status as never;
    if (query.search) {
      where['OR'] = [
        { name:  { contains: query.search, mode: 'insensitive' } },
        { email: { contains: query.search, mode: 'insensitive' } },
        { login: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    const [rows, total] = await Promise.all([
      prisma.client.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.client.count({ where }),
    ]);
    return { data: rows.map(toCustomer), total, page, limit };
  }

  async findById(id: string): Promise<Customer> {
    const row = await prisma.client.findUnique({ where: { id } });
    if (!row) throw new ClientNotFoundError(id);
    return toCustomer(row);
  }

  async stats(): Promise<ClientStats> {
    const groups = await prisma.client.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    const out: ClientStats = { total: 0, active: 0, inactive: 0, blocked: 0, late: 0 };
    for (const g of groups) {
      const count = g._count._all;
      out.total += count;
      const key = g.status as keyof Omit<ClientStats, 'total'>;
      if (key in out) out[key] = count;
    }
    return out;
  }

  async delete(id: string): Promise<boolean> {
    try {
      await prisma.client.delete({ where: { id } });
      return true;
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      // Prisma P2025 -> row to delete does not exist; treat as a not-found.
      if (code === 'P2025') return false;
      throw err;
    }
  }

  async create(data: CreateCustomerInput): Promise<Customer> {
    const row = await prisma.client.create({
      data: {
        name: data.name,
        email: data.email,
        phone: data.phone,
        login: data.login,
        status: (data.status ?? 'active') as never,
        address: data.address ?? null,
        city: data.city ?? null,
        country: data.country ?? null,
        splynxId: data.splynxId ?? null,
        customAttributes: (data.customAttributes as never) ?? undefined,
      },
    });
    return toCustomer(row);
  }

  async listServices(clientId: string): Promise<Service[]> {
    const rows = await prisma.service.findMany({
      where: { clientId },
      orderBy: { startDate: 'desc' },
    });
    return rows.map(toService);
  }

  async listInvoices(clientId: string): Promise<Invoice[]> {
    const rows = await prisma.invoice.findMany({
      where: { clientId },
      orderBy: { issueDate: 'desc' },
    });
    return rows.map(toInvoice);
  }

  async listLogs(query: ListLogsQuery): Promise<PaginatedResult<ClientLog>> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 25;
    const where = { clientId: query.clientId };
    const [rows, total] = await Promise.all([
      prisma.clientLog.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.clientLog.count({ where }),
    ]);
    return { data: rows.map(toClientLog), total, page, limit };
  }
}
