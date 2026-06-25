import { IpKind, IpNetwork, IpPool } from '@domain/entities/network';
import { IpNetworkRepository } from '@domain/ports/IpNetworkRepository';
import { NasRepository } from '@domain/ports/NasRepository';
import { PppoeRouterGateway } from '@domain/ports/PppoeRouterGateway';
import { RadiusOrchestratorGateway } from '@domain/ports/RadiusOrchestratorGateway';
import { NasNotFoundError } from '@domain/errors/pppoe';
import { NoFreeIpError, NoPoolForNasTypeError } from '@domain/errors/network';
import { ipToInt, intToIp, networkEdges } from '@domain/services/ipMath';
import { routesViaOrchestrator } from '@domain/entities/nas';

export interface FindFreeIpInput {
  nasId: string;
  type: IpKind;
}

/**
 * FindFreeIp — primer IP libre de un NAS para una clase (cgnat|public).
 *
 * Rango del pool (rangeStart..rangeEnd) MENOS:
 *   - las IPs ASIGNADAS, ruteadas por `nas.type`:
 *       · `radius_orchestrator` → el RADIUS (radreply Framed-IP, `orchestrator.listAssignedIps`),
 *          que es la fuente de verdad de las IPs tomadas para este NAS,
 *       · resto → los `remote-address` vivos del router (`/ppp secret`),
 *   - el gateway de la red,
 *   - el network address y el broadcast del CIDR de la red.
 *
 * El ruteo por tipo evita que el allocator ofrezca un IP libre-en-router pero
 * tomado-en-RADIUS (el create del orchestrator devolvería 409).
 *
 * Depende SÓLO de puertos (pool repo, nas repo, router, orchestrator). Nada de infra/Prisma.
 */
export class FindFreeIp {
  constructor(
    private readonly networkRepo: IpNetworkRepository,
    private readonly nasRepo: NasRepository,
    private readonly router: PppoeRouterGateway,
    private readonly orchestrator: RadiusOrchestratorGateway,
  ) {}

  async execute(input: FindFreeIpInput): Promise<string> {
    const nas = await this.nasRepo.findNasServerById(input.nasId);
    if (!nas) throw new NasNotFoundError(input.nasId);

    const pools = await this.networkRepo.findPoolsByNas(input.nasId);
    const pool = pools.find((p) => p.ipKind === input.type);
    if (!pool) throw new NoPoolForNasTypeError(input.nasId, input.type);

    const network = await this.networkRepo.findNetworkById(pool.networkId);

    // Fuente de IPs asignadas ruteada por tipo de NAS: para `radius_orchestrator` la verdad
    // vive en el RADIUS (radreply), no en el router.
    const assignedIps =
      routesViaOrchestrator(nas.type)
        ? await this.orchestrator.listAssignedIps()
        : await this.router.listAssignedIps({ ipAddress: nas.ipAddress, apiPort: nas.apiPort ?? 8728 });

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
