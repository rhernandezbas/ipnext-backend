import { OltDevice, OnuDevice } from '@domain/entities/gpon';
import { GponRepository } from '@domain/ports/GponRepository';
import { prisma } from '../../database/prisma';

function toOlt(row: any): OltDevice {
  return {
    id: row.id,
    name: row.name,
    ipAddress: row.ipAddress ?? null,
    model: row.model ?? null,
    manufacturer: row.manufacturer ?? null,
    uplink: row.uplink ?? null,
    ponPorts: row.ponPorts,
    totalOnus: row.totalOnus,
    onlineOnus: row.onlineOnus,
    status: row.status,
    lastSeen: row.lastSeen
      ? (row.lastSeen instanceof Date ? row.lastSeen.toISOString() : row.lastSeen)
      : null,
  };
}

function toOnu(row: any): OnuDevice {
  return {
    id: row.id,
    serialNumber: row.serialNumber ?? null,
    model: row.model ?? null,
    oltId: row.oltId,
    oltName: row.olt?.name ?? '',
    ponPort: row.ponPort ?? null,
    onuId: row.onuId ?? null,
    clientId: row.clientId ?? null,
    clientName: row.clientName ?? null,
    status: row.status,
    rxPower: row.rxPower ?? null,
    txPower: row.txPower ?? null,
    distance: row.distance ?? null,
    firmwareVersion: row.firmwareVersion ?? null,
    lastSeen: row.lastSeen
      ? (row.lastSeen instanceof Date ? row.lastSeen.toISOString() : row.lastSeen)
      : null,
  };
}

export class InMemoryGponRepository implements GponRepository {
  async listOlts(): Promise<OltDevice[]> {
    const rows = await prisma.oltDevice.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map(toOlt);
  }

  async getOlt(id: string): Promise<OltDevice | null> {
    const row = await prisma.oltDevice.findUnique({ where: { id } });
    return row ? toOlt(row) : null;
  }

  async createOlt(
    data: Omit<OltDevice, 'id' | 'totalOnus' | 'onlineOnus' | 'status' | 'lastSeen'>,
  ): Promise<OltDevice> {
    const row = await prisma.oltDevice.create({
      data: {
        name: data.name,
        ipAddress: data.ipAddress ?? null,
        model: data.model ?? null,
        manufacturer: data.manufacturer ?? null,
        uplink: data.uplink ?? null,
        ponPorts: data.ponPorts ?? 0,
        totalOnus: 0,
        onlineOnus: 0,
        status: 'online',
        lastSeen: new Date(),
      },
    });
    return toOlt(row);
  }

  async listOnus(): Promise<OnuDevice[]> {
    const rows = await prisma.onuDevice.findMany({
      include: { olt: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toOnu);
  }

  async getOnu(id: string): Promise<OnuDevice | null> {
    const row = await prisma.onuDevice.findUnique({
      where: { id },
      include: { olt: { select: { name: true } } },
    });
    return row ? toOnu(row) : null;
  }

  async listOnusByOlt(oltId: string): Promise<OnuDevice[]> {
    const rows = await prisma.onuDevice.findMany({
      where: { oltId },
      include: { olt: { select: { name: true } } },
    });
    return rows.map(toOnu);
  }

  async createOnu(
    data: Omit<OnuDevice, 'id' | 'oltName' | 'onuId' | 'rxPower' | 'txPower' | 'distance' | 'firmwareVersion' | 'lastSeen' | 'status'>,
  ): Promise<OnuDevice> {
    const row = await prisma.onuDevice.create({
      data: {
        serialNumber: data.serialNumber ?? null,
        model: data.model ?? null,
        oltId: data.oltId,
        ponPort: data.ponPort ?? null,
        clientId: data.clientId ?? null,
        clientName: data.clientName ?? null,
        status: 'unconfigured',
        rxPower: null,
        txPower: null,
        distance: null,
        firmwareVersion: null,
        lastSeen: null,
      },
      include: { olt: { select: { name: true } } },
    });
    return toOnu(row);
  }

  async updateOnuStatus(id: string, status: OnuDevice['status']): Promise<OnuDevice | null> {
    try {
      const row = await prisma.onuDevice.update({
        where: { id },
        data: { status },
        include: { olt: { select: { name: true } } },
      });
      return toOnu(row);
    } catch {
      return null;
    }
  }
}
