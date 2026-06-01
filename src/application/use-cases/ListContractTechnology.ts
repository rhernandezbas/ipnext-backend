import { ContractTechnologyRepository } from '@domain/ports/ContractTechnologyRepository';
import { ContractTechnology } from '@domain/entities/contractTechnology';

export class ListContractTechnology {
  constructor(private readonly repo: ContractTechnologyRepository) {}
  async execute(): Promise<ContractTechnology[]> {
    return this.repo.list();
  }
}
