import { CpeDevice } from '@domain/entities/cpe';
import { CpeRepository } from '@domain/ports/CpeRepository';
import { prisma } from '../../database/prisma';

function toCpe(row: any): CpeDevice {
  return {
    id: row.id,
    serialNumber: row.serialNumber ?? null,
    model: row.model ?? null,
    manufacturer: row.manufacturer ?? null,
    type: row.type,
    macAddress: row.macAddress ?? null,
    ipAddress: row.ipAddress ?? null,
    status: row.status,
    clientId: row.clientId ?? null,
    clientName: row.clientName ?? null,
    nasId: row.nasId ?? null,
    networkSiteId: row.networkSiteId ?? null,
    firmwareVersion: row.firmwareVersion ?? null,
    lastSeen: row.lastSeen
      ? (row.lastSeen instanceof Date ? row.lastSeen.toISOString() : row.lastSeen)
      : null,
    signal: row.signal ?? null,
    connectedAt: row.connectedAt
      ? (row.connectedAt instanceof Date ? row.connectedAt.toISOString() : row.connectedAt)
      : null,
    description: row.description ?? null,
  };
}

export class InMemoryCpeRepository implements CpeRepository {
  async findAll(): Promise<CpeDevice[]> {
    const rows = await prisma.cpeDevice.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map(toCpe);
  }

  async findById(id: string): Promise<CpeDevice | null> {
    const row = await prisma.cpeDevice.findUnique({ where: { id } });
    return row ? toCpe(row) : null;
  }

  async create(data: Omit<CpeDevice, 'id'>): Promise<CpeDevice> {
    const row = await prisma.cpeDevice.create({
      data: {
        serialNumber: data.serialNumber ?? null,
        model: data.model ?? null,
        manufacturer: data.manufacturer ?? null,
        type: data.type,
        macAddress: data.macAddress ?? null,
        ipAddress: data.ipAddress ?? null,
        status: data.status ?? 'unconfigured',
        clientId: data.clientId ?? null,
        clientName: data.clientName ?? null,
        nasId: data.nasId ?? null,
        networkSiteId: data.networkSiteId ?? null,
        firmwareVersion: data.firmwareVersion ?? null,
        lastSeen: data.lastSeen ? new Date(data.lastSeen) : null,
        signal: data.signal ?? null,
        connectedAt: data.connectedAt ? new Date(data.connectedAt) : null,
        description: data.description ?? null,
      },
    });
    return toCpe(row);
  }

  async update(id: string, data: Partial<CpeDevice>): Promise<CpeDevice | null> {
    try {
      const row = await prisma.cpeDevice.update({
        where: { id },
        data: {
          ...(data.serialNumber !== undefined && { serialNumber: data.serialNumber }),
          ...(data.model !== undefined && { model: data.model }),
          ...(data.manufacturer !== undefined && { manufacturer: data.manufacturer }),
          ...(data.type !== undefined && { type: data.type }),
          ...(data.macAddress !== undefined && { macAddress: data.macAddress }),
          ...(data.ipAddress !== undefined && { ipAddress: data.ipAddress }),
          ...(data.status !== undefined && { status: data.status }),
          ...(data.clientId !== undefined && { clientId: data.clientId }),
          ...(data.clientName !== undefined && { clientName: data.clientName }),
          ...(data.nasId !== undefined && { nasId: data.nasId }),
          ...(data.networkSiteId !== undefined && { networkSiteId: data.networkSiteId }),
          ...(data.firmwareVersion !== undefined && { firmwareVersion: data.firmwareVersion }),
          ...(data.lastSeen !== undefined && {
            lastSeen: data.lastSeen ? new Date(data.lastSeen) : null,
          }),
          ...(data.signal !== undefined && { signal: data.signal }),
          ...(data.connectedAt !== undefined && {
            connectedAt: data.connectedAt ? new Date(data.connectedAt) : null,
          }),
          ...(data.description !== undefined && { description: data.description }),
        },
      });
      return toCpe(row);
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await prisma.cpeDevice.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  async assignToClient(id: string, clientId: string, clientName: string): Promise<CpeDevice | null> {
    return this.update(id, { clientId, clientName });
  }
}
