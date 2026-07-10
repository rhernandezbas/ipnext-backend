import { ContractInventoryRepository, ClientInstalledItemRow } from '@domain/ports/ContractInventoryRepository';
import { ContractInstalledItem } from '@domain/entities/contract-installed-item';
import { InstalledItemNotFoundError, InstalledItemAlreadyRemovedError } from '@domain/errors/inventory';
import { prisma } from '../../database/prisma';
import { PrismaClientLike } from './PrismaClientLike';

type Row = {
  id: string; contractId: string; type: string; serialNumber: string | null; mac: string | null;
  model: string | null; source: string; sourceTaskId: string | null; addedByUserId: string | null;
  confirmedAt: Date | null; status: string; notes: string | null; replacesItemId: string | null;
  assetId: string | null;
  createdAt: Date; updatedAt: Date;
};

function toEntity(r: Row): ContractInstalledItem {
  return {
    id: r.id, contractId: r.contractId, type: r.type as ContractInstalledItem['type'],
    serialNumber: r.serialNumber, mac: r.mac, model: r.model, source: r.source,
    sourceTaskId: r.sourceTaskId, addedByUserId: r.addedByUserId,
    confirmedAt: r.confirmedAt ? r.confirmedAt.toISOString() : null,
    status: r.status as ContractInstalledItem['status'], notes: r.notes,
    replacesItemId: r.replacesItemId ?? null,
    assetId: r.assetId ?? null,
    createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  };
}

export class PrismaContractInventoryRepository implements ContractInventoryRepository {
  constructor(private readonly db: PrismaClientLike = prisma) {}

  async listByContract(contractId: string): Promise<ContractInstalledItem[]> {
    const rows = await this.db.contractInstalledItem.findMany({ where: { contractId }, orderBy: { createdAt: 'asc' } });
    return rows.map(toEntity);
  }

  async listByClient(clientId: string): Promise<ClientInstalledItemRow[]> {
    // Single JOIN: CII ⋈ Contract WHERE Contract.clientId = $id. Sin N+1.
    const rows = await this.db.contractInstalledItem.findMany({
      where: { contract: { clientId } },
      include: { contract: { select: { plan: true, type: true } } },
      orderBy: [{ contractId: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((r: Row & { contract: { plan: string; type: string } }) => ({
      ...toEntity(r),
      contractPlan: r.contract.plan,
      contractType: r.contract.type,
    }));
  }

  async getById(id: string): Promise<ContractInstalledItem | null> {
    const row = await this.db.contractInstalledItem.findUnique({ where: { id } });
    return row ? toEntity(row) : null;
  }

  async create(item: ContractInstalledItem): Promise<ContractInstalledItem> {
    const row = await this.db.contractInstalledItem.create({
      data: {
        id: item.id, contractId: item.contractId, type: item.type, serialNumber: item.serialNumber,
        mac: item.mac, model: item.model, source: item.source, sourceTaskId: item.sourceTaskId,
        addedByUserId: item.addedByUserId, confirmedAt: item.confirmedAt ? new Date(item.confirmedAt) : null,
        status: item.status, notes: item.notes, replacesItemId: item.replacesItemId ?? null,
        assetId: item.assetId ?? null,
        createdAt: new Date(item.createdAt), updatedAt: new Date(item.updatedAt),
      },
    });
    return toEntity(row);
  }

  async update(id: string, patch: Partial<ContractInstalledItem>): Promise<ContractInstalledItem | null> {
    const existing = await this.db.contractInstalledItem.findUnique({ where: { id } });
    if (!existing) return null;
    const row = await this.db.contractInstalledItem.update({
      where: { id },
      data: {
        ...(patch.status !== undefined && { status: patch.status }),
        ...(patch.notes !== undefined && { notes: patch.notes }),
        ...(patch.model !== undefined && { model: patch.model }),
        ...(patch.serialNumber !== undefined && { serialNumber: patch.serialNumber }),
        ...(patch.mac !== undefined && { mac: patch.mac }),
        ...(patch.assetId !== undefined && { assetId: patch.assetId }),
      },
    });
    return toEntity(row);
  }

  async remove(id: string): Promise<ContractInstalledItem | null> {
    const existing = await this.db.contractInstalledItem.findUnique({ where: { id } });
    if (!existing) return null;
    const row = await this.db.contractInstalledItem.update({
      where: { id },
      data: { status: 'removed' },
    });
    return toEntity(row);
  }

  // service-transfer (W3) — reasigna SOLO contractId. Fix wave L1: update CONDICIONAL
  // (updateMany WHERE { id, status: 'active' }) — como el repo corre tx-scoped en el UnitOfWork,
  // esto mata la ventana del retire concurrente entre la validación del use case y la tx: una
  // fila que dejó de estar active matchea 0 y el lote aborta tipado (rollback). count 0 se
  // diagnostica re-leyendo: inexistente → NotFound; no-active → AlreadyRemoved (paridad InMemory).
  async transferToContract(itemId: string, targetContractId: string): Promise<void> {
    const result = await this.db.contractInstalledItem.updateMany({
      where: { id: itemId, status: 'active' },
      data: { contractId: targetContractId },
    });
    if (result.count === 0) {
      const existing = await this.db.contractInstalledItem.findUnique({ where: { id: itemId } });
      if (!existing) throw new InstalledItemNotFoundError(itemId);
      throw new InstalledItemAlreadyRemovedError(itemId);
    }
  }
}
