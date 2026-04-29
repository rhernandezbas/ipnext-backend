import { HardwareAsset } from '@domain/entities/hardware';
import { HardwareRepository } from '@domain/ports/HardwareRepository';
import { prisma } from '../../database/prisma';

function toAsset(row: any): HardwareAsset {
  return {
    id: row.id,
    name: row.name,
    category: row.type,
    serialNumber: row.serialNumber ?? null,
    model: row.model ?? null,
    manufacturer: row.manufacturer ?? null,
    purchaseDate: row.purchaseDate
      ? (row.purchaseDate instanceof Date ? row.purchaseDate.toISOString().split('T')[0] : row.purchaseDate)
      : null,
    purchasePrice: row.purchasePrice ?? null,
    warrantyExpiry: row.warranty ?? null,
    location: row.location ?? null,
    networkSiteId: null,
    status: row.status,
    assignedTo: row.assignedTo ?? null,
    notes: row.notes ?? null,
  };
}

export class InMemoryHardwareRepository implements HardwareRepository {
  async findAll(): Promise<HardwareAsset[]> {
    const rows = await prisma.hardwareAsset.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map(toAsset);
  }

  async create(data: Omit<HardwareAsset, 'id'>): Promise<HardwareAsset> {
    const row = await prisma.hardwareAsset.create({
      data: {
        name: data.name,
        type: data.category,
        manufacturer: data.manufacturer ?? null,
        model: data.model ?? null,
        serialNumber: data.serialNumber ?? null,
        purchaseDate: data.purchaseDate ? new Date(data.purchaseDate) : null,
        purchasePrice: data.purchasePrice ?? null,
        location: data.location ?? null,
        status: data.status ?? 'in_use',
        warranty: data.warrantyExpiry ?? null,
        assignedTo: data.assignedTo ?? null,
        notes: data.notes ?? null,
      },
    });
    return toAsset(row);
  }

  async update(id: string, data: Partial<HardwareAsset>): Promise<HardwareAsset | null> {
    try {
      const row = await prisma.hardwareAsset.update({
        where: { id },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.category !== undefined && { type: data.category }),
          ...(data.manufacturer !== undefined && { manufacturer: data.manufacturer }),
          ...(data.model !== undefined && { model: data.model }),
          ...(data.serialNumber !== undefined && { serialNumber: data.serialNumber }),
          ...(data.purchaseDate !== undefined && {
            purchaseDate: data.purchaseDate ? new Date(data.purchaseDate) : null,
          }),
          ...(data.purchasePrice !== undefined && { purchasePrice: data.purchasePrice }),
          ...(data.location !== undefined && { location: data.location }),
          ...(data.status !== undefined && { status: data.status }),
          ...(data.warrantyExpiry !== undefined && { warranty: data.warrantyExpiry }),
          ...(data.assignedTo !== undefined && { assignedTo: data.assignedTo }),
          ...(data.notes !== undefined && { notes: data.notes }),
        },
      });
      return toAsset(row);
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await prisma.hardwareAsset.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }
}
