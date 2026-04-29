export interface IpNetwork {
  id: string;
  network: string;       // CIDR e.g. "192.168.1.0/24"
  gateway: string;       // e.g. "192.168.1.1"
  dns1: string;
  dns2: string;
  description: string;
  partnerId: string | null;
  type: 'static' | 'dhcp' | 'pppoe';
  totalIps: number;
  usedIps: number;
  freeIps: number;
}

export interface IpPool {
  id: string;
  name: string;
  networkId: string;
  rangeStart: string;    // e.g. "192.168.1.10"
  rangeEnd: string;      // e.g. "192.168.1.200"
  type: 'static' | 'dynamic';
  assignedCount: number;
  totalCount: number;
  nasId: string | null;
}

export interface IpAssignment {
  id: string;
  ip: string;
  poolId: string;
  clientId: string;
  servicePlanId: string;
  assignedAt: string;
  status: 'assigned' | 'free' | 'reserved';
}

export interface Ipv6Network {
  id: string;
  network: string;
  description: string;
  delegationPrefix: number;
  type: 'static' | 'dhcpv6' | 'slaac';
  usedPrefixes: number;
  totalPrefixes: number;
  status: 'active' | 'inactive';
}
