import { CustomerRepository } from '@domain/ports/CustomerRepository';
import { Customer } from '@domain/entities/customer';

export class GetClientDetail {
  constructor(private readonly repo: CustomerRepository) {}

  execute(id: string): Promise<Customer> {
    return this.repo.findById(id);
  }
}
