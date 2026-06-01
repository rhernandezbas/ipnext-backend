import { ContractTechnologyRepository } from '@domain/ports/ContractTechnologyRepository';
import { ContractTechnology } from '@domain/entities/contractTechnology';
import { ContractTechnologyNameConflictError } from '@domain/errors/contractTechnology';

export class CreateContractTechnology {
  constructor(private readonly repo: ContractTechnologyRepository) {}
  async execute(data: { name: string; description?: string | null }): Promise<ContractTechnology> {
    const existing = await this.repo.getByName(data.name);
    if (existing) throw new ContractTechnologyNameConflictError(data.name);
    return this.repo.create({ name: data.name, description: data.description ?? null });
  }
}
