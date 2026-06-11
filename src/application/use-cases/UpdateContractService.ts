import { ContractServiceRepository } from '@domain/ports/ContractServiceRepository';
import { ContractServiceView } from '@domain/entities/contract-service';
import { ContractServiceNotFoundError } from '@domain/errors/contractServices';

export class UpdateContractService {
  constructor(private readonly csRepo: ContractServiceRepository) {}
  async execute(id: string, data: { status?: string; notes?: string | null }): Promise<ContractServiceView> {
    const updated = await this.csRepo.update(id, data);
    if (!updated) throw new ContractServiceNotFoundError(id);
    return updated;
  }
}
