import { prisma } from '../../database/prisma';
import type { UispSiteRepository } from '@domain/ports/UispSiteRepository';
import type { UispSite } from '@domain/entities/uisp';

/**
 * Prisma implementation of UispSiteRepository.
 *
 * Upsert strategy: per-row upsert in a sequential for-loop (200 rows/chunk).
 * WHY: Prisma has no native bulk-upsert. createMany cannot update. Each upsert is
 * an individual DB call — NOT a $transaction. Sequential await between calls yields
 * the event loop so the 5-min cron never blocks request handling.
 * 4009 rows / 200 ≈ 21 chunks; each chunk iterates row-by-row.
 */
const CHUNK_SIZE = 200;

function toEntity(row: {
  id: string;
  uispId: string;
  name: string;
  status: string;
  parentUispId: string | null;
  latitude: number | null;
  longitude: number | null;
  deviceCount: number;
  outageCount: number;
  contact: string | null;
  address?: string | null;
  missingSince: Date | null;
  lastSyncAt: Date;
  createdAt: Date;
  updatedAt: Date;
}): UispSite {
  return {
    id: row.id,
    uispId: row.uispId,
    name: row.name,
    status: row.status,
    parentUispId: row.parentUispId,
    latitude: row.latitude,
    longitude: row.longitude,
    deviceCount: row.deviceCount,
    outageCount: row.outageCount,
    contact: row.contact,
    address: row.address ?? null,
    missingSince: row.missingSince,
    lastSyncAt: row.lastSyncAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class PrismaUispSiteRepository implements UispSiteRepository {
  async upsert(site: UispSite): Promise<void> {
    const now = new Date();
    await prisma.uispSite.upsert({
      where: { uispId: site.uispId },
      create: {
        uispId: site.uispId,
        name: site.name,
        status: site.status,
        parentUispId: site.parentUispId,
        latitude: site.latitude,
        longitude: site.longitude,
        deviceCount: site.deviceCount,
        outageCount: site.outageCount,
        contact: site.contact,
        address: site.address ?? null,
        missingSince: site.missingSince,
        lastSyncAt: site.lastSyncAt,
        updatedAt: now,
      },
      update: {
        name: site.name,
        status: site.status,
        parentUispId: site.parentUispId,
        latitude: site.latitude,
        longitude: site.longitude,
        deviceCount: site.deviceCount,
        outageCount: site.outageCount,
        contact: site.contact,
        address: site.address ?? null,
        lastSyncAt: site.lastSyncAt,
        updatedAt: now,
      },
    });
  }

  async listAll(): Promise<UispSite[]> {
    const rows = await prisma.uispSite.findMany({ orderBy: { name: 'asc' } });
    return rows.map(toEntity);
  }

  async findByUispId(uispId: string): Promise<UispSite | null> {
    const row = await prisma.uispSite.findUnique({ where: { uispId } });
    return row ? toEntity(row) : null;
  }

  async markMissing(uispIds: string[], since: Date): Promise<void> {
    for (let i = 0; i < uispIds.length; i += CHUNK_SIZE) {
      const chunk = uispIds.slice(i, i + CHUNK_SIZE);
      await prisma.uispSite.updateMany({
        where: { uispId: { in: chunk }, missingSince: null },
        data: { missingSince: since, updatedAt: new Date() },
      });
    }
  }

  async clearMissing(uispIds: string[]): Promise<void> {
    for (let i = 0; i < uispIds.length; i += CHUNK_SIZE) {
      const chunk = uispIds.slice(i, i + CHUNK_SIZE);
      await prisma.uispSite.updateMany({
        where: { uispId: { in: chunk } },
        data: { missingSince: null, updatedAt: new Date() },
      });
    }
  }
}
