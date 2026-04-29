import { IpNetwork, IpPool, IpAssignment, Ipv6Network } from '@domain/entities/network';
import { IpNetworkRepository } from '@domain/ports/IpNetworkRepository';
import { prisma } from '../../database/prisma';

// Ipv6Network has no Prisma model yet — keep in memory
const ipv6Networks: Ipv6Network[] = [
  {
    id: '1',
    network: '2001:db8::/32',
    description: 'Bloque IPv6 principal ISP',
    delegationPrefix: 48,
    type: 'static',
    usedPrefixes: 12,
    totalPrefixes: 65536,
    status: 'active',
  },
  {
    id: '2',
    network: '2800:200::/32',
    description: 'Bloque IPv6 clientes residenciales DHCPv6',
    delegationPrefix: 56,
    type: 'dhcpv6',
    usedPrefixes: 35,
    totalPrefixes: 16777216,
    status: 'active',
  },
];
let nextIpv6Id = 3;

function toNetwork(row: any): IpNetwork {
  return {
    id: row.id,
    network: row.network,
    description: row.description ?? '',
    // fields not in Prisma model — use defaults
    gateway: '',
    dns1: '',
    dns2: '',
    partnerId: null,
    type: 'dhcp',
    totalIps: 0,
    usedIps: 0,
    freeIps: 0,
  };
}

function toPool(row: any): IpPool {
  return {
    id: row.id,
    name: row.name,
    networkId: row.networkId,
    rangeStart: row.rangeStart,
    rangeEnd: row.rangeEnd,
    type: 'dynamic',
    assignedCount: 0,
    totalCount: 0,
    nasId: null,
  };
}

function toAssignment(row: any): IpAssignment {
  return {
    id: row.id,
    ip: row.ipAddress,
    poolId: row.poolId,
    clientId: row.clientId ?? '',
    servicePlanId: row.servicePlanId ?? '',
    assignedAt: row.assignedAt instanceof Date ? row.assignedAt.toISOString() : row.assignedAt,
    status: row.releasedAt ? 'free' : 'assigned',
  };
}

export class InMemoryIpNetworkRepository implements IpNetworkRepository {
  async findAllNetworks(): Promise<IpNetwork[]> {
    const rows = await prisma.ipNetwork.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map(toNetwork);
  }

  async findNetworkById(id: string): Promise<IpNetwork | null> {
    const row = await prisma.ipNetwork.findUnique({ where: { id } });
    return row ? toNetwork(row) : null;
  }

  async createNetwork(data: Omit<IpNetwork, 'id'>): Promise<IpNetwork> {
    const row = await prisma.ipNetwork.create({
      data: {
        name: data.network,
        network: data.network,
        status: 'active',
        description: data.description || null,
      },
    });
    return toNetwork(row);
  }

  async deleteNetwork(id: string): Promise<boolean> {
    try {
      await prisma.ipNetwork.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  async findAllPools(): Promise<IpPool[]> {
    const rows = await prisma.ipPool.findMany();
    return rows.map(toPool);
  }

  async findPoolById(id: string): Promise<IpPool | null> {
    const row = await prisma.ipPool.findUnique({ where: { id } });
    return row ? toPool(row) : null;
  }

  async createPool(data: Omit<IpPool, 'id'>): Promise<IpPool> {
    const row = await prisma.ipPool.create({
      data: {
        networkId: data.networkId,
        name: data.name,
        rangeStart: data.rangeStart,
        rangeEnd: data.rangeEnd,
        status: 'active',
      },
    });
    return toPool(row);
  }

  async deletePool(id: string): Promise<boolean> {
    try {
      await prisma.ipPool.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  async findAllAssignments(): Promise<IpAssignment[]> {
    const rows = await prisma.ipAssignment.findMany({ orderBy: { assignedAt: 'desc' } });
    return rows.map(toAssignment);
  }

  async findAllIpv6Networks(): Promise<Ipv6Network[]> {
    return [...ipv6Networks];
  }

  async createIpv6Network(data: Omit<Ipv6Network, 'id'>): Promise<Ipv6Network> {
    const network: Ipv6Network = { ...data, id: String(nextIpv6Id++) };
    ipv6Networks.push(network);
    return network;
  }
}
