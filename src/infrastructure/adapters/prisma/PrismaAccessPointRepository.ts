import { prisma } from '../../database/prisma';
import type { AccessPoint } from '@domain/entities/accessPoint';
import type { AccessPointRepository, UpsertAccessPointInput } from '@domain/ports/AccessPointRepository';

/**
 * Prisma implementation of AccessPointRepository.
 * Derived catalog — rows are owned by SyncUispMirror (upsert by uispDeviceId). Never deleted here.
 */
const CHUNK_SIZE = 200;

function toEntity(row: {
  id: string;
  uispDeviceId: string;
  networkSiteId: string | null;
  name: string;
  mac: string | null;
  missingSince: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): AccessPoint {
  return {
    id: row.id,
    uispDeviceId: row.uispDeviceId,
    networkSiteId: row.networkSiteId,
    name: row.name,
    mac: row.mac,
    missingSince: row.missingSince,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class PrismaAccessPointRepository implements AccessPointRepository {
  async upsertByUispDeviceId(input: UpsertAccessPointInput): Promise<AccessPoint> {
    const row = await prisma.accessPoint.upsert({
      where: { uispDeviceId: input.uispDeviceId },
      create: {
        uispDeviceId: input.uispDeviceId,
        networkSiteId: input.networkSiteId,
        name: input.name,
        mac: input.mac,
      },
      update: {
        networkSiteId: input.networkSiteId,
        name: input.name,
        mac: input.mac,
      },
    });
    return toEntity(row);
  }

  async findMany(): Promise<AccessPoint[]> {
    const rows = await prisma.accessPoint.findMany({ orderBy: { name: 'asc' } });
    return rows.map(toEntity);
  }

  async findByNetworkSiteId(networkSiteId: string): Promise<AccessPoint[]> {
    const rows = await prisma.accessPoint.findMany({
      where: { networkSiteId },
      orderBy: { name: 'asc' },
    });
    return rows.map(toEntity);
  }

  async findById(id: string): Promise<AccessPoint | null> {
    const row = await prisma.accessPoint.findUnique({ where: { id } });
    return row ? toEntity(row) : null;
  }

  // FIX-2: stamp missingSince on retired APs. Only where currently null (preserves the
  // original date), chunked — mirrors PrismaUispDeviceRepository.markMissing.
  async markMissing(uispDeviceIds: string[], since: Date): Promise<void> {
    for (let i = 0; i < uispDeviceIds.length; i += CHUNK_SIZE) {
      const chunk = uispDeviceIds.slice(i, i + CHUNK_SIZE);
      await prisma.accessPoint.updateMany({
        where: { uispDeviceId: { in: chunk }, missingSince: null },
        data: { missingSince: since },
      });
    }
  }

  // FIX-2: clear missingSince on reappeared APs.
  async clearMissing(uispDeviceIds: string[]): Promise<void> {
    for (let i = 0; i < uispDeviceIds.length; i += CHUNK_SIZE) {
      const chunk = uispDeviceIds.slice(i, i + CHUNK_SIZE);
      await prisma.accessPoint.updateMany({
        where: { uispDeviceId: { in: chunk } },
        data: { missingSince: null },
      });
    }
  }
}
