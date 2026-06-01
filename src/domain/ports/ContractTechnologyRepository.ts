import { ContractTechnology } from '../entities/contractTechnology';

export interface ContractTechnologyRepository {
  list(): Promise<ContractTechnology[]>;
  getById(id: string): Promise<ContractTechnology | null>;
  getByName(name: string): Promise<ContractTechnology | null>;
  create(data: { name: string; description: string | null }): Promise<ContractTechnology>;
  update(id: string, data: Partial<{ name: string; description: string | null }>): Promise<ContractTechnology | null>;
  delete(id: string): Promise<boolean>;
  countContractsUsingTechnology(name: string): Promise<number>;
}
