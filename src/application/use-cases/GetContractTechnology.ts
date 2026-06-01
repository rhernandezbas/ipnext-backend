import { ContractTechnologyRepository } from '@domain/ports/ContractTechnologyRepository';
import { ContractTechnology } from '@domain/entities/contractTechnology';
import { ContractTechnologyNotFoundError } from '@domain/errors/contractTechnology';

export class GetContractTechnology {
  constructor(private readonly repo: ContractTechnologyRepository) {}
  async execute(id: string): Promise<ContractTechnology> {
    const item = await this.repo.getById(id);
    if (!item) throw new ContractTechnologyNotFoundError(id);
    return item;
  }
}
