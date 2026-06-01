import { ContractTechnology } from '@domain/entities/contractTechnology';
import { ContractTechnologyRepository } from '@domain/ports/ContractTechnologyRepository';
import { prisma } from '../../database/prisma';

function toContractTechnology(row: any): ContractTechnology {
  return { id: row.id, name: row.name, description: row.description ?? null };
}

export class PrismaContractTechnologyRepository implements ContractTechnologyRepository {
  async list(): Promise<ContractTechnology[]> {
    const rows = await prisma.contractTechnology.findMany({ orderBy: { name: 'asc' } });
    return rows.map(toContractTechnology);
  }

  async getById(id: string): Promise<ContractTechnology | null> {
    const row = await prisma.contractTechnology.findUnique({ where: { id } });
    return row ? toContractTechnology(row) : null;
  }

  async getByName(name: string): Promise<ContractTechnology | null> {
    const rows = await prisma.contractTechnology.findMany();
    const row = rows.find((r: any) => r.name.toLowerCase() === name.toLowerCase());
    return row ? toContractTechnology(row) : null;
  }

  async create(data: { name: string; description: string | null }): Promise<ContractTechnology> {
    const row = await prisma.contractTechnology.create({ data });
    return toContractTechnology(row);
  }

  async update(id: string, data: Partial<{ name: string; description: string | null }>): Promise<ContractTechnology | null> {
    try {
      const row = await prisma.contractTechnology.update({ where: { id }, data });
      return toContractTechnology(row);
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await prisma.contractTechnology.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  async countContractsUsingTechnology(name: string): Promise<number> {
    // Contract.technology stores the technology name as a free-text column (Phase 1, no FK).
    return prisma.contract.count({ where: { technology: name } });
  }
}
