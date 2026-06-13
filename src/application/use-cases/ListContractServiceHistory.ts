import { ContractServiceRepository } from '@domain/ports/ContractServiceRepository';
import {
  ContractServiceHistoryItemDto,
  toContractServiceHistoryItemDto,
} from '@application/dto/contract-services.dto';

/**
 * #73 — Returns the FULL service history (active + inactive ContractService rows)
 * for a given contract. Result is ordered by createdAt asc. tvPassword is NEVER
 * present in the returned DTOs — the mapper strips it at the boundary.
 */
export class ListContractServiceHistory {
  constructor(private readonly csRepo: ContractServiceRepository) {}

  async execute(contractId: string): Promise<ContractServiceHistoryItemDto[]> {
    const views = await this.csRepo.listByContract(contractId);
    return views.map(toContractServiceHistoryItemDto);
  }
}
