import { IpNetworkRepository } from '@domain/ports/IpNetworkRepository';
import { NasRepository } from '@domain/ports/NasRepository';
import { PppoeRouterGateway } from '@domain/ports/PppoeRouterGateway';
import { RadiusOrchestratorGateway } from '@domain/ports/RadiusOrchestratorGateway';
import { IpNetwork } from '@domain/entities/network';
import { usableIpsInCidr, countAssignedInCidr } from '@domain/services/ipMath';
import { AssignedIpsProvider } from '@application/services/AssignedIpsProvider';

/**
 * Lista las redes con sus contadores REALES:
 *   - `totalIps` = IPs usables del CIDR (bloque menos network y broadcast),
 *   - `usedIps`  = cuántas de las IPs ASIGNADAS de los NAS de la red caen dentro del CIDR,
 *   - `freeIps`  = total − used.
 *
 * Las IPs asignadas se descubren por los pools de la red (cada pool conoce su `nasId`) y la
 * fuente se rutea por `nas.type` (mikrotik_radius → RADIUS; resto → router), igual que el allocator.
 * La tabla IpAssignment está vacía en prod: no se usa para contar.
 *
 * Degrada por red: si algún NAS está caído, sus IPs cuentan 0 y la lista sigue (nunca 500).
 * El `AssignedIpsProvider` cachea por NAS: redes/pools que comparten NAS hacen UN solo fetch.
 */
export class ListIpNetworks {
  constructor(
    private readonly repo: IpNetworkRepository,
    private readonly nasRepo: NasRepository,
    private readonly router: PppoeRouterGateway,
    private readonly orchestrator: RadiusOrchestratorGateway,
  ) {}

  async execute(): Promise<IpNetwork[]> {
    const [networks, pools] = await Promise.all([
      this.repo.findAllNetworks(),
      this.repo.findAllPools(),
    ]);
    const provider = new AssignedIpsProvider(this.nasRepo, this.router, this.orchestrator);

    // nasIds DISTINTOS por red (vía sus pools). Set para no consultar dos veces el mismo NAS.
    const nasIdsByNetwork = new Map<string, Set<string>>();
    for (const pool of pools) {
      if (!pool.nasId) continue;
      const set = nasIdsByNetwork.get(pool.networkId) ?? new Set<string>();
      set.add(pool.nasId);
      nasIdsByNetwork.set(pool.networkId, set);
    }

    return Promise.all(
      networks.map(async (net) => {
        const nasIds = nasIdsByNetwork.get(net.id) ?? new Set<string>();
        // Reunir las asignadas de todos los NAS de la red (el provider dedupe el RADIUS global
        // por su clave sintética; aquí dedupe por IP el countAssignedInCidr).
        const lists = await Promise.all([...nasIds].map((id) => provider.forNas(id)));
        const assigned = lists.flat();

        const totalIps = usableIpsInCidr(net.network);
        const usedIps = countAssignedInCidr(assigned, net.network);
        const freeIps = totalIps - usedIps > 0 ? totalIps - usedIps : 0;
        return { ...net, totalIps, usedIps, freeIps };
      }),
    );
  }
}
