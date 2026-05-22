import { CustomerRepository, ClientStats } from '@domain/ports/CustomerRepository';

export class GetClientStats {
  constructor(private readonly repo: CustomerRepository) {}

  execute(): Promise<ClientStats> {
    return this.repo.stats();
  }
}
