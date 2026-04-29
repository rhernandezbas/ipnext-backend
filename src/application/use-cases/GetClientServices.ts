import { CustomerRepository } from '@domain/ports/CustomerRepository';
import { Service } from '@domain/entities/customer';

export class GetClientServices {
  constructor(private readonly repo: CustomerRepository) {}

  execute(clientId: string): Promise<Service[]> {
    return this.repo.listServices(clientId);
  }
}
