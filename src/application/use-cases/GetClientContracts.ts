import { CustomerRepository } from '@domain/ports/CustomerRepository';
import { Contract } from '@domain/entities/customer';

export class GetClientContracts {
  constructor(private readonly repo: CustomerRepository) {}

  execute(clientId: string): Promise<Contract[]> {
    return this.repo.listContracts(clientId);
  }
}
