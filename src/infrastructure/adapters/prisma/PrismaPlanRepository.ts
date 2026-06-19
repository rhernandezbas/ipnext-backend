import { Plan } from '@domain/entities/plan';
import { PlanRepository, PlanUpsert } from '@domain/ports/PlanRepository';
import { PlanNotFoundError } from '@domain/errors/plan';
import { prisma } from '../../database/prisma';

function model() { return (prisma as any).plan; }

export class PrismaPlanRepository implements PlanRepository {
  async upsertByCode(data: PlanUpsert): Promise<Plan> {
    const row = await model().upsert({
      where: { code: data.code },
      create: { ...data, status: data.status ?? 'enabled' },
      update: {
        name: data.name,
        category: data.category,
        downloadKbps: data.downloadKbps,
        uploadKbps: data.uploadKbps,
        ...(data.status ? { status: data.status } : {}),
      },
    });
    return toEntity(row);
  }

  async list(): Promise<Plan[]> {
    return (await model().findMany()).map(toEntity);
  }

  async findById(id: string): Promise<Plan | null> {
    const r = await model().findUnique({ where: { id } });
    return r ? toEntity(r) : null;
  }

  async findByCode(code: string): Promise<Plan | null> {
    const r = await model().findUnique({ where: { code } });
    return r ? toEntity(r) : null;
  }

  async delete(id: string): Promise<void> {
    try {
      await model().delete({ where: { id } });
    } catch (err: any) {
      if (err?.code === 'P2025') throw new PlanNotFoundError(id);
      throw err;
    }
  }
}

function toEntity(row: any): Plan {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    category: row.category,
    downloadKbps: row.downloadKbps,
    uploadKbps: row.uploadKbps,
    status: row.status,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}
