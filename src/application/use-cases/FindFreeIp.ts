import { IpKind, IpNetwork, IpPool } from '@domain/entities/network';
import { IpNetworkRepository } from '@domain/ports/IpNetworkRepository';
import { NasRepository } from '@domain/ports/NasRepository';
import { PppoeRouterGateway, NasTarget } from '@domain/ports/PppoeRouterGateway';
import { NasNotFoundError } from '@domain/errors/pppoe';
import { NoFreeIpError, NoPoolForNasTypeError } from '@domain/errors/network';

export interface FindFreeIpInput {
  nasId: string;
  type: IpKind;
}

/** IPv4 dotted-quad → entero sin signo de 32 bits. */
function ipToInt(ip: string): number {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) throw new Error(`IPv4 inválida: ${ip}`);
  let acc = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      throw new Error(`IPv4 inválida: ${ip}`);
    }
    acc = acc * 256 + octet;
  }
  return acc >>> 0;
}

/** Entero de 32 bits → IPv4 dotted-quad. */
function intToIp(n: number): string {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
}

/** Network + broadcast de un CIDR "a.b.c.d/p". null si el CIDR no es parseable. */
function networkEdges(cidr: string): { network: number; broadcast: number } | null {
  const [base, prefixStr] = cidr.split('/');
  if (!base || prefixStr === undefined) return null;
  const prefix = Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  let baseInt: number;
  try {
    baseInt = ipToInt(base);
  } catch {
    return null;
  }
  // mask de `prefix` bits. /0 → 0; /32 → 0xffffffff.
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (baseInt & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  return { network, broadcast };
}

/**
 * FindFreeIp — primer IP libre de un NAS para una clase (cgnat|public).
 *
 * Rango del pool (rangeStart..rangeEnd) MENOS:
 *   - los `remote-address` vivos del router (`/ppp secret`, fuente de verdad VIVA),
 *   - el gateway de la red,
 *   - el network address y el broadcast del CIDR de la red.
 *
 * Depende SÓLO de puertos (pool repo, nas repo, gateway). Nada de infra/Prisma.
 */
export class FindFreeIp {
  constructor(
    private readonly networkRepo: IpNetworkRepository,
    private readonly nasRepo: NasRepository,
    private readonly router: PppoeRouterGateway,
  ) {}

  async execute(input: FindFreeIpInput): Promise<string> {
    const nas = await this.nasRepo.findNasServerById(input.nasId);
    if (!nas) throw new NasNotFoundError(input.nasId);

    const pools = await this.networkRepo.findPoolsByNas(input.nasId);
    const pool = pools.find((p) => p.ipKind === input.type);
    if (!pool) throw new NoPoolForNasTypeError(input.nasId, input.type);

    const network = await this.networkRepo.findNetworkById(pool.networkId);

    const target: NasTarget = { ipAddress: nas.ipAddress, apiPort: nas.apiPort ?? 8728 };
    const assignedIps = await this.router.listAssignedIps(target);

    const ip = this.firstFree(pool, network, assignedIps);
    if (!ip) throw new NoFreeIpError(pool.id);
    return ip;
  }

  /** Recorre el rango y devuelve el primer IP libre, o null si no hay. */
  private firstFree(pool: IpPool, network: IpNetwork | null, assignedIps: string[]): string | null {
    const start = ipToInt(pool.rangeStart);
    const end = ipToInt(pool.rangeEnd);
    if (end < start) return null;

    // Direcciones a EXCLUIR (set de enteros). Asignadas + gateway + network/broadcast.
    const excluded = new Set<number>();
    for (const a of assignedIps) {
      try {
        excluded.add(ipToInt(a));
      } catch {
        /* ignorar valores no-IPv4 que pudiera devolver el router */
      }
    }
    if (network) {
      if (network.gateway) {
        try {
          excluded.add(ipToInt(network.gateway));
        } catch {
          /* gateway vacío/inválido → no excluye nada */
        }
      }
      const edges = networkEdges(network.network);
      if (edges) {
        excluded.add(edges.network);
        excluded.add(edges.broadcast);
      }
    }

    for (let n = start; n <= end; n++) {
      if (!excluded.has(n)) return intToIp(n);
    }
    return null;
  }
}
