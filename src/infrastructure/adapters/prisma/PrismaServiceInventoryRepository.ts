import { ServiceInventoryRepository } from '@domain/ports/ServiceInventoryRepository';
import { ServiceInstalledItem } from '@domain/entities/service-installed-item';
import { prisma } from '../../database/prisma';

type Row = {
  id: string; serviceId: string; type: string; serialNumber: string | null; mac: string | null;
  model: string | null; source: string; sourceTaskId: string | null; addedByUserId: string | null;
  confirmedAt: Date | null; status: string; notes: string | null; createdAt: Date; updatedAt: Date;
};

function toEntity(r: Row): ServiceInstalledItem {
  return {
    id: r.id, serviceId: r.serviceId, type: r.type as ServiceInstalledItem['type'],
    serialNumber: r.serialNumber, mac: r.mac, model: r.model, source: r.source,
    sourceTaskId: r.sourceTaskId, addedByUserId: r.addedByUserId,
    confirmedAt: r.confirmedAt ? r.confirmedAt.toISOString() : null,
    status: r.status as ServiceInstalledItem['status'], notes: r.notes,
    createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  };
}

export class PrismaServiceInventoryRepository implements ServiceInventoryRepository {
  async listByService(serviceId: string): Promise<ServiceInstalledItem[]> {
    const rows = await prisma.serviceInstalledItem.findMany({ where: { serviceId }, orderBy: { createdAt: 'asc' } });
    return rows.map(toEntity);
  }

  async create(item: ServiceInstalledItem): Promise<ServiceInstalledItem> {
    const row = await prisma.serviceInstalledItem.create({
      data: {
        id: item.id, serviceId: item.serviceId, type: item.type, serialNumber: item.serialNumber,
        mac: item.mac, model: item.model, source: item.source, sourceTaskId: item.sourceTaskId,
        addedByUserId: item.addedByUserId, confirmedAt: item.confirmedAt ? new Date(item.confirmedAt) : null,
        status: item.status, notes: item.notes,
        createdAt: new Date(item.createdAt), updatedAt: new Date(item.updatedAt),
      },
    });
    return toEntity(row);
  }

  async update(id: string, patch: Partial<ServiceInstalledItem>): Promise<ServiceInstalledItem | null> {
    const existing = await prisma.serviceInstalledItem.findUnique({ where: { id } });
    if (!existing) return null;
    const row = await prisma.serviceInstalledItem.update({
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
}
