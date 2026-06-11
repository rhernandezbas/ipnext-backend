import { ContractRepository } from '@domain/ports/ContractRepository';
import { ContractNotFoundError } from '@domain/errors/contractServices';

export class UpdateContractName {
  constructor(private readonly contractRepo: ContractRepository) {}
  async execute(id: string, name?: string | null): Promise<{ id: string; name: string | null }> {
    // W-3 — body {} (name absent → undefined) is a no-op: don't touch the column,
    // just confirm the contract exists and echo back the current name.
    const normalized =
      name === undefined ? undefined
      : name === null ? null
      : (name.trim() === '' ? null : name.trim()); // CN-2.2: empty/whitespace → null
    const result = await this.contractRepo.updateName(id, normalized);
    if (!result) throw new ContractNotFoundError(id);
    return result;
  }
}
