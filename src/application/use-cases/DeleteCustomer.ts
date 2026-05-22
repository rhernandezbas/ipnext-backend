import { CustomerRepository } from '@domain/ports/CustomerRepository';

export class DeleteCustomer {
  constructor(private readonly repo: CustomerRepository) {}

  execute(id: string): Promise<boolean> {
    return this.repo.delete(id);
  }
}
