import { ContractTechnologyRepository } from '@domain/ports/ContractTechnologyRepository';
import { ContractTechnologyNotFoundError, ContractTechnologyInUseError } from '@domain/errors/contractTechnology';

export class DeleteContractTechnology {
  constructor(private readonly repo: ContractTechnologyRepository) {}
  async execute(id: string): Promise<void> {
    const item = await this.repo.getById(id);
    if (!item) throw new ContractTechnologyNotFoundError(id);

    // Contracts store technology as a free-text name column — guard by name.
    const count = await this.repo.countContractsUsingTechnology(item.name);
    if (count > 0) throw new ContractTechnologyInUseError(count);

    await this.repo.delete(id);
  }
}
