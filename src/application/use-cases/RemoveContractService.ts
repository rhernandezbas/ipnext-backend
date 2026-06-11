import { ContractServiceRepository } from '@domain/ports/ContractServiceRepository';

export class RemoveContractService {
  constructor(private readonly csRepo: ContractServiceRepository) {}
  /** Idempotent: a missing id is a no-op (route returns 204 either way, spec CSV-3.2). */
  async execute(id: string): Promise<void> {
    await this.csRepo.delete(id);
  }
}
