import { DeviceTypeCatalog } from '@domain/entities/device-type-catalog';
import { DeviceTypeCatalogRepository } from '@domain/ports/DeviceTypeCatalogRepository';
import { prisma } from '../../database/prisma';

function toDeviceTypeCatalog(row: any): DeviceTypeCatalog {
  return {
    id: row.id,
    name: row.name,
    label: row.label ?? null,
    active: row.active,
    sortOrder: row.sortOrder,
  };
}

export class PrismaDeviceTypeCatalogRepository implements DeviceTypeCatalogRepository {
  async list(): Promise<DeviceTypeCatalog[]> {
    const rows = await (prisma as any).deviceTypeCatalog.findMany({ orderBy: { sortOrder: 'asc' } });
    return rows.map(toDeviceTypeCatalog);
  }

  async getById(id: string): Promise<DeviceTypeCatalog | null> {
    const row = await (prisma as any).deviceTypeCatalog.findUnique({ where: { id } });
    return row ? toDeviceTypeCatalog(row) : null;
  }

  async getByName(name: string): Promise<DeviceTypeCatalog | null> {
    const rows = await (prisma as any).deviceTypeCatalog.findMany();
    const row = rows.find((r: any) => r.name.toLowerCase() === name.toLowerCase());
    return row ? toDeviceTypeCatalog(row) : null;
  }

  async create(data: { name: string; label?: string | null; active?: boolean; sortOrder?: number }): Promise<DeviceTypeCatalog> {
    const row = await (prisma as any).deviceTypeCatalog.create({ data });
    return toDeviceTypeCatalog(row);
  }

  async update(id: string, data: Partial<{ name: string; label: string | null; active: boolean; sortOrder: number }>): Promise<DeviceTypeCatalog | null> {
    try {
      const row = await (prisma as any).deviceTypeCatalog.update({ where: { id }, data });
      return toDeviceTypeCatalog(row);
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await (prisma as any).deviceTypeCatalog.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  async countInUse(typeName: string): Promise<number> {
    return (prisma as any).contractInstalledItem.count({ where: { type: typeName } });
  }

  async listActiveNames(): Promise<string[]> {
    const rows = await (prisma as any).deviceTypeCatalog.findMany({ where: { active: true } });
    return rows.map((r: any) => r.name.toUpperCase());
  }
}
