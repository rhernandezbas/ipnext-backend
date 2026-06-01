import { ContractTechnologyRepository } from '@domain/ports/ContractTechnologyRepository';
import { ContractTechnology } from '@domain/entities/contractTechnology';
import { ContractTechnologyNotFoundError, ContractTechnologyNameConflictError } from '@domain/errors/contractTechnology';

export class UpdateContractTechnology {
  constructor(private readonly repo: ContractTechnologyRepository) {}
  async execute(id: string, data: { name?: string; description?: string | null }): Promise<ContractTechnology> {
    const item = await this.repo.getById(id);
    if (!item) throw new ContractTechnologyNotFoundError(id);

    if (data.name && data.name.toLowerCase() !== item.name.toLowerCase()) {
      const conflict = await this.repo.getByName(data.name);
      if (conflict && conflict.id !== id) throw new ContractTechnologyNameConflictError(data.name);
    }

    const updated = await this.repo.update(id, data);
    if (!updated) throw new ContractTechnologyNotFoundError(id);
    return updated;
  }
}
