import { IpNetwork, IpPool, IpAssignment, Ipv6Network } from '../entities/network';

export interface IpNetworkRepository {
  findAllNetworks(): Promise<IpNetwork[]>;
  findNetworkById(id: string): Promise<IpNetwork | null>;
  createNetwork(data: Omit<IpNetwork, 'id'>): Promise<IpNetwork>;
  deleteNetwork(id: string): Promise<boolean>;

  findAllPools(): Promise<IpPool[]>;
  findPoolById(id: string): Promise<IpPool | null>;
  createPool(data: Omit<IpPool, 'id'>): Promise<IpPool>;
  deletePool(id: string): Promise<boolean>;

  findAllAssignments(): Promise<IpAssignment[]>;

  findAllIpv6Networks(): Promise<Ipv6Network[]>;
  createIpv6Network(data: Omit<Ipv6Network, 'id'>): Promise<Ipv6Network>;
}
