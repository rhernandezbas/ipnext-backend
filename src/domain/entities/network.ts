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
  /** `null` = la fuente de IPs asignadas (router/RADIUS) no está disponible (no es un 0 real). */
  usedIps: number | null;
  /** `null` = no se puede calcular libres porque `usedIps` no es confiable. */
  freeIps: number | null;
}

/** Clase de direccionamiento del pool — eje ORTOGONAL a `type` (static/dynamic). */
export type IpKind = 'cgnat' | 'public';

export interface IpPool {
  id: string;
  name: string;
  networkId: string;
  rangeStart: string;    // e.g. "192.168.1.10"
  rangeEnd: string;      // e.g. "192.168.1.200"
  type: 'static' | 'dynamic';
  /** `null` = la fuente de IPs asignadas (router/RADIUS) no está disponible (no es un 0 real). */
  assignedCount: number | null;
  totalCount: number;
  nasId: string | null;
  /**
   * Clase de IP del pool, usada por el allocator (FindFreeIp) para resolver
   * el pool de un NAS dado un `type` cgnat|public. `null` en pools legacy
   * que no participan del allocator.
   */
  ipKind: IpKind | null;
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
