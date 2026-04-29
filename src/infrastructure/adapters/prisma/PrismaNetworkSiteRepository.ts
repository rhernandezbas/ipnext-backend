import { NetworkSite } from '@domain/entities/networkSite';
import { NetworkSiteRepository } from '@domain/ports/NetworkSiteRepository';
import { prisma } from '../../database/prisma';

function toSite(row: any): NetworkSite {
  return {
    id: row.id,
    name: row.name,
    address: row.address ?? null,
    city: row.city ?? null,
    coordinates: (row.lat != null && row.lng != null)
      ? { lat: row.lat, lng: row.lng }
      : null,
    type: row.type,
    status: row.status,
    deviceCount: row.deviceCount,
    clientCount: row.clientCount,
    uplink: row.uplink ?? null,
    parentSiteId: row.parentSiteId ?? null,
    description: row.description ?? null,
  };
}

export class InMemoryNetworkSiteRepository implements NetworkSiteRepository {
  async findAll(): Promise<NetworkSite[]> {
    const rows = await prisma.networkSite.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map(toSite);
  }

  async findById(id: string): Promise<NetworkSite | null> {
    const row = await prisma.networkSite.findUnique({ where: { id } });
    return row ? toSite(row) : null;
  }

  async create(data: Omit<NetworkSite, 'id'>): Promise<NetworkSite> {
    const row = await prisma.networkSite.create({
      data: {
        name: data.name,
        address: data.address ?? null,
        city: data.city ?? null,
        lat: data.coordinates?.lat ?? null,
        lng: data.coordinates?.lng ?? null,
        type: data.type ?? 'nodo',
        status: data.status ?? 'active',
        deviceCount: data.deviceCount ?? 0,
        clientCount: data.clientCount ?? 0,
        uplink: data.uplink ?? null,
        parentSiteId: data.parentSiteId ?? null,
        description: data.description ?? null,
      },
    });
    return toSite(row);
  }

  async update(id: string, data: Partial<NetworkSite>): Promise<NetworkSite | null> {
    try {
      const row = await prisma.networkSite.update({
        where: { id },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.address !== undefined && { address: data.address }),
          ...(data.city !== undefined && { city: data.city }),
          ...(data.coordinates !== undefined && {
            lat: data.coordinates?.lat ?? null,
            lng: data.coordinates?.lng ?? null,
          }),
          ...(data.type !== undefined && { type: data.type }),
          ...(data.status !== undefined && { status: data.status }),
          ...(data.deviceCount !== undefined && { deviceCount: data.deviceCount }),
          ...(data.clientCount !== undefined && { clientCount: data.clientCount }),
          ...(data.uplink !== undefined && { uplink: data.uplink }),
          ...(data.parentSiteId !== undefined && { parentSiteId: data.parentSiteId }),
          ...(data.description !== undefined && { description: data.description }),
        },
      });
      return toSite(row);
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await prisma.networkSite.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }
}
