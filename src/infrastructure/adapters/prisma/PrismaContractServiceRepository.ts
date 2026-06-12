import { ContractServiceView } from '@domain/entities/contract-service';
import { ContractServiceRepository } from '@domain/ports/ContractServiceRepository';
import { ContractServiceDuplicateError } from '@domain/errors/contractServices';
import { prisma } from '../../database/prisma';

/** Maps a ContractService row (with `serviceCatalog` joined) to the view. */
function toView(row: any): ContractServiceView {
  return {
    id: row.id,
    contractId: row.contractId,
    serviceCatalogId: row.serviceCatalogId,
    name: row.serviceCatalog?.name ?? '',
    label: row.serviceCatalog?.label ?? null,
    status: row.status,
    notes: row.notes ?? null,
    tvLogin: row.tvLogin ?? null,
    tvPassword: row.tvPassword ?? null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  };
}

const INCLUDE = { serviceCatalog: true } as const;

export class PrismaContractServiceRepository implements ContractServiceRepository {
  async getById(id: string): Promise<ContractServiceView | null> {
    const row = await (prisma as any).contractService.findUnique({ where: { id }, include: INCLUDE });
    return row ? toView(row) : null;
  }

  async getByPair(contractId: string, serviceCatalogId: string): Promise<ContractServiceView | null> {
    const row = await (prisma as any).contractService.findUnique({
      where: { contractId_serviceCatalogId: { contractId, serviceCatalogId } },
      include: INCLUDE,
    });
    return row ? toView(row) : null;
  }

  async add(data: { contractId: string; serviceCatalogId: string; notes?: string | null; tvLogin?: string | null; tvPassword?: string | null }): Promise<ContractServiceView> {
    try {
      const row = await (prisma as any).contractService.create({
        data: {
          contractId: data.contractId,
          serviceCatalogId: data.serviceCatalogId,
          notes: data.notes ?? null,
          ...(data.tvLogin !== undefined ? { tvLogin: data.tvLogin } : {}),
          ...(data.tvPassword !== undefined ? { tvPassword: data.tvPassword } : {}),
        },
        include: INCLUDE,
      });
      return toView(row);
    } catch (err: unknown) {
      // P2002 — unique (contractId, serviceCatalogId) violation (covers the race the
      // use-case pre-check can miss). Map to the domain duplicate error.
      if ((err as { code?: string })?.code === 'P2002') throw new ContractServiceDuplicateError();
      throw err;
    }
  }

  async update(id: string, data: { status?: string; notes?: string | null }): Promise<ContractServiceView | null> {
    try {
      const row = await (prisma as any).contractService.update({ where: { id }, data, include: INCLUDE });
      return toView(row);
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await (prisma as any).contractService.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }
}
