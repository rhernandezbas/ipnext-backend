import { CustomerRepository } from '@domain/ports/CustomerRepository';
import { Invoice } from '@domain/entities/billing';

export class GetClientInvoices {
  constructor(private readonly repo: CustomerRepository) {}

  execute(clientId: string): Promise<Invoice[]> {
    return this.repo.listInvoices(clientId);
  }
}
