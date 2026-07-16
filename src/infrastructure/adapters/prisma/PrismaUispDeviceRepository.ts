import { prisma } from '../../database/prisma';
import type { UispDeviceRepository } from '@domain/ports/UispDeviceRepository';
import type { UispDevice } from '@domain/entities/uisp';

/**
 * Prisma implementation of UispDeviceRepository.
 * Per-row upsert in a sequential for-loop — mirrors PrismaUispSiteRepository.
 * Each upsert is an individual DB call, NOT a $transaction.
 */
const CHUNK_SIZE = 200;

function toEntity(row: {
  id: string;
  uispId: string;
  uispSiteId: string;
  name: string;
  model: string;
  modelName: string | null;
  type: string | null;
  role: string | null;
  mac: string | null;
  ip: string | null;
  firmware: string | null;
  status: string;
  signal: number | null;
  uptime: bigint | null;
  lastSeenAt: Date | null;
  missingSince: Date | null;
  apUispDeviceId: string | null;
  lastSyncAt: Date;
  createdAt: Date;
  updatedAt: Date;
}): UispDevice {
  return {
    id: row.id,
    uispId: row.uispId,
    uispSiteId: row.uispSiteId,
    name: row.name,
    model: row.model,
    modelName: row.modelName,
    type: row.type,
    role: row.role,
    mac: row.mac,
    ip: row.ip,
    firmware: row.firmware,
    status: row.status,
    signal: row.signal,
    uptime: row.uptime,
    lastSeenAt: row.lastSeenAt,
    missingSince: row.missingSince,
    apUispDeviceId: row.apUispDeviceId,
    lastSyncAt: row.lastSyncAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class PrismaUispDeviceRepository implements UispDeviceRepository {
  async upsert(device: UispDevice): Promise<void> {
    const now = new Date();
    await prisma.uispDevice.upsert({
      where: { uispId: device.uispId },
      create: {
        uispId: device.uispId,
        uispSiteId: device.uispSiteId,
        name: device.name,
        model: device.model,
        modelName: device.modelName,
        type: device.type,
        role: device.role,
        mac: device.mac,
        ip: device.ip,
        firmware: device.firmware,
        status: device.status,
        signal: device.signal,
        uptime: device.uptime,
        lastSeenAt: device.lastSeenAt,
        missingSince: device.missingSince,
        apUispDeviceId: device.apUispDeviceId,
        lastSyncAt: device.lastSyncAt,
        updatedAt: now,
      },
      update: {
        uispSiteId: device.uispSiteId,
        name: device.name,
        model: device.model,
        modelName: device.modelName,
        type: device.type,
        role: device.role,
        mac: device.mac,
        ip: device.ip,
        firmware: device.firmware,
        status: device.status,
        signal: device.signal,
        uptime: device.uptime,
        lastSeenAt: device.lastSeenAt,
        apUispDeviceId: device.apUispDeviceId,
        lastSyncAt: device.lastSyncAt,
        updatedAt: now,
      },
    });
  }

  async listAll(): Promise<UispDevice[]> {
    const rows = await prisma.uispDevice.findMany({ orderBy: { name: 'asc' } });
    return rows.map(toEntity);
  }

  async listBySiteId(uispSiteId: string): Promise<UispDevice[]> {
    const rows = await prisma.uispDevice.findMany({
      where: { uispSiteId },
      orderBy: { name: 'asc' },
    });
    return rows.map(toEntity);
  }

  async findByUispId(uispId: string): Promise<UispDevice | null> {
    const row = await prisma.uispDevice.findUnique({ where: { uispId } });
    return row ? toEntity(row) : null;
  }

  async markMissing(uispIds: string[], since: Date): Promise<void> {
    for (let i = 0; i < uispIds.length; i += CHUNK_SIZE) {
      const chunk = uispIds.slice(i, i + CHUNK_SIZE);
      await prisma.uispDevice.updateMany({
        where: { uispId: { in: chunk }, missingSince: null },
        data: { missingSince: since, updatedAt: new Date() },
      });
    }
  }

  async clearMissing(uispIds: string[]): Promise<void> {
    for (let i = 0; i < uispIds.length; i += CHUNK_SIZE) {
      const chunk = uispIds.slice(i, i + CHUNK_SIZE);
      await prisma.uispDevice.updateMany({
        where: { uispId: { in: chunk } },
        data: { missingSince: null, updatedAt: new Date() },
      });
    }
  }
}
