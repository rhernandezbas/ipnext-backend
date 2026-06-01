import { ContractRepository, ContractStats } from '@domain/ports/ContractRepository';

export class GetContractStats {
  constructor(private readonly repo: ContractRepository) {}

  execute(): Promise<ContractStats> {
    return this.repo.stats();
  }
}
