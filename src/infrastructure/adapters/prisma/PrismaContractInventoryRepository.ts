import { ContractInventoryRepository } from '@domain/ports/ContractInventoryRepository';
import { ContractInstalledItem } from '@domain/entities/contract-installed-item';
import { prisma } from '../../database/prisma';

type Row = {
  id: string; contractId: string; type: string; serialNumber: string | null; mac: string | null;
  model: string | null; source: string; sourceTaskId: string | null; addedByUserId: string | null;
  confirmedAt: Date | null; status: string; notes: string | null; createdAt: Date; updatedAt: Date;
};

function toEntity(r: Row): ContractInstalledItem {
  return {
    id: r.id, contractId: r.contractId, type: r.type as ContractInstalledItem['type'],
    serialNumber: r.serialNumber, mac: r.mac, model: r.model, source: r.source,
    sourceTaskId: r.sourceTaskId, addedByUserId: r.addedByUserId,
    confirmedAt: r.confirmedAt ? r.confirmedAt.toISOString() : null,
    status: r.status as ContractInstalledItem['status'], notes: r.notes,
    createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  };
}

export class PrismaContractInventoryRepository implements ContractInventoryRepository {
  async listByContract(contractId: string): Promise<ContractInstalledItem[]> {
    const rows = await prisma.contractInstalledItem.findMany({ where: { contractId }, orderBy: { createdAt: 'asc' } });
    return rows.map(toEntity);
  }

  async getById(id: string): Promise<ContractInstalledItem | null> {
    const row = await prisma.contractInstalledItem.findUnique({ where: { id } });
    return row ? toEntity(row) : null;
  }

  async create(item: ContractInstalledItem): Promise<ContractInstalledItem> {
    const row = await prisma.contractInstalledItem.create({
      data: {
        id: item.id, contractId: item.contractId, type: item.type, serialNumber: item.serialNumber,
        mac: item.mac, model: item.model, source: item.source, sourceTaskId: item.sourceTaskId,
        addedByUserId: item.addedByUserId, confirmedAt: item.confirmedAt ? new Date(item.confirmedAt) : null,
        status: item.status, notes: item.notes,
        createdAt: new Date(item.createdAt), updatedAt: new Date(item.updatedAt),
      },
    });
    return toEntity(row);
  }

  async update(id: string, patch: Partial<ContractInstalledItem>): Promise<ContractInstalledItem | null> {
    const existing = await prisma.contractInstalledItem.findUnique({ where: { id } });
    if (!existing) return null;
    const row = await prisma.contractInstalledItem.update({
      where: { id },
      data: {
        ...(patch.status !== undefined && { status: patch.status }),
        ...(patch.notes !== undefined && { notes: patch.notes }),
        ...(patch.model !== undefined && { model: patch.model }),
        ...(patch.serialNumber !== undefined && { serialNumber: patch.serialNumber }),
        ...(patch.mac !== undefined && { mac: patch.mac }),
      },
    });
    return toEntity(row);
  }

  async remove(id: string): Promise<ContractInstalledItem | null> {
    const existing = await prisma.contractInstalledItem.findUnique({ where: { id } });
    if (!existing) return null;
    const row = await prisma.contractInstalledItem.update({
      where: { id },
      data: { status: 'removed' },
    });
    return toEntity(row);
  }
}
