import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type { PortalInvoiceDto } from '@application/dto/portal/portalInvoice.dto';
import type { PaginatedQuery, PaginatedResult } from '@application/dto/pagination';

/**
 * ListPortalInvoices — customer-portal-api (Fase 4, task 4.2).
 *
 * portal-self-service spec "Mis facturas": `clientId` SIEMPRE del token (ver
 * GetPortalMe). `CustomerRepository.listInvoices` no documenta un orden
 * garantizado en el port — el orden desc por `issueDate` y el paginado son
 * responsabilidad de ESTE use case, no del adapter.
 */
export class ListPortalInvoices {
  constructor(private readonly customers: CustomerRepository) {}

  async execute(clientId: string, query: PaginatedQuery): Promise<PaginatedResult<PortalInvoiceDto>> {
    const invoices = await this.customers.listInvoices(clientId);
    const sorted = [...invoices].sort(
      (a, b) => new Date(b.issueDate).getTime() - new Date(a.issueDate).getTime(),
    );

    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 25;
    const start = (page - 1) * limit;
    const data = sorted.slice(start, start + limit).map(toPortalInvoiceDto);

    return { data, total: sorted.length, page, limit };
  }
}

function toPortalInvoiceDto(invoice: {
  number: string;
  issueDate: string;
  dueDate: string;
  amount: number;
  balance: number | null;
  status: string;
  pdfUrl: string | null;
  paymentUrl: string | null;
}): PortalInvoiceDto {
  return {
    number: invoice.number,
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    amount: invoice.amount,
    balance: invoice.balance,
    status: invoice.status,
    pdfUrl: invoice.pdfUrl,
    paymentUrl: invoice.paymentUrl,
  };
}
