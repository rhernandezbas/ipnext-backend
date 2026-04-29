import { IpNetwork, IpPool, IpAssignment, Ipv6Network } from '@domain/entities/network';
import { IpNetworkRepository } from '@domain/ports/IpNetworkRepository';

let nextNetworkId = 3;
let nextPoolId = 4;
let nextAssignmentId = 6;
let nextIpv6Id = 3;

export class InMemoryIpNetworkRepository implements IpNetworkRepository {
  private networks: IpNetwork[] = [
    {
      id: '1',
      network: '192.168.1.0/24',
      gateway: '192.168.1.1',
      dns1: '8.8.8.8',
      dns2: '8.8.4.4',
      description: 'Red de clientes residenciales',
      partnerId: null,
      type: 'dhcp',
      totalIps: 254,
      usedIps: 50,
      freeIps: 204,
    },
    {
      id: '2',
      network: '10.0.0.0/16',
      gateway: '10.0.0.1',
      dns1: '1.1.1.1',
      dns2: '1.0.0.1',
      description: 'Red de gestión interna',
      partnerId: null,
      type: 'static',
      totalIps: 65534,
      usedIps: 5,
      freeIps: 65529,
    },
  ];

  private pools: IpPool[] = [
    {
      id: '1',
      name: 'residencial-dinamico',
      networkId: '1',
      rangeStart: '192.168.1.10',
      rangeEnd: '192.168.1.200',
      type: 'dynamic',
      assignedCount: 50,
      totalCount: 191,
      nasId: '1',
    },
    {
      id: '2',
      name: 'empresas-estatico',
      networkId: '1',
      rangeStart: '192.168.1.201',
      rangeEnd: '192.168.1.250',
      type: 'static',
      assignedCount: 0,
      totalCount: 50,
      nasId: null,
    },
    {
      id: '3',
      name: 'gestion',
      networkId: '2',
      rangeStart: '10.0.0.10',
      rangeEnd: '10.0.0.100',
      type: 'static',
      assignedCount: 5,
      totalCount: 91,
      nasId: null,
    },
  ];

  private ipv6Networks: Ipv6Network[] = [
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

  private assignments: IpAssignment[] = [
    {
      id: '1',
      ip: '192.168.1.10',
      poolId: '1',
      clientId: 'client-001',
      servicePlanId: 'plan-1',
      assignedAt: '2026-01-15T10:00:00Z',
      status: 'assigned',
    },
    {
      id: '2',
      ip: '192.168.1.11',
      poolId: '1',
      clientId: 'client-002',
      servicePlanId: 'plan-1',
      assignedAt: '2026-01-16T11:00:00Z',
      status: 'assigned',
    },
    {
      id: '3',
      ip: '192.168.1.12',
      poolId: '1',
      clientId: 'client-003',
      servicePlanId: 'plan-2',
      assignedAt: '2026-02-01T09:00:00Z',
      status: 'assigned',
    },
    {
      id: '4',
      ip: '10.0.0.10',
      poolId: '3',
      clientId: 'admin-001',
      servicePlanId: 'plan-admin',
      assignedAt: '2026-01-01T00:00:00Z',
      status: 'reserved',
    },
    {
      id: '5',
      ip: '192.168.1.13',
      poolId: '1',
      clientId: 'client-004',
      servicePlanId: 'plan-1',
      assignedAt: '2026-03-10T14:00:00Z',
      status: 'assigned',
    },
  ];

  async findAllNetworks(): Promise<IpNetwork[]> {
    return [...this.networks];
  }

  async findNetworkById(id: string): Promise<IpNetwork | null> {
    return this.networks.find(n => n.id === id) ?? null;
  }

  async createNetwork(data: Omit<IpNetwork, 'id'>): Promise<IpNetwork> {
    const network: IpNetwork = { ...data, id: String(nextNetworkId++) };
    this.networks.push(network);
    return network;
  }

  async deleteNetwork(id: string): Promise<boolean> {
    const index = this.networks.findIndex(n => n.id === id);
    if (index === -1) return false;
    this.networks.splice(index, 1);
    return true;
  }

  async findAllPools(): Promise<IpPool[]> {
    return [...this.pools];
  }

  async findPoolById(id: string): Promise<IpPool | null> {
    return this.pools.find(p => p.id === id) ?? null;
  }

  async createPool(data: Omit<IpPool, 'id'>): Promise<IpPool> {
    const pool: IpPool = { ...data, id: String(nextPoolId++) };
    this.pools.push(pool);
    return pool;
  }

  async deletePool(id: string): Promise<boolean> {
    const index = this.pools.findIndex(p => p.id === id);
    if (index === -1) return false;
    this.pools.splice(index, 1);
    return true;
  }

  async findAllAssignments(): Promise<IpAssignment[]> {
    return [...this.assignments];
  }

  async findAllIpv6Networks(): Promise<Ipv6Network[]> {
    return [...this.ipv6Networks];
  }

  async createIpv6Network(data: Omit<Ipv6Network, 'id'>): Promise<Ipv6Network> {
    const network: Ipv6Network = { ...data, id: String(nextIpv6Id++) };
    this.ipv6Networks.push(network);
    return network;
  }
}
