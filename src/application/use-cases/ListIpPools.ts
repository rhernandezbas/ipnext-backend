import { IpNetworkRepository } from '@domain/ports/IpNetworkRepository';
import { NasRepository } from '@domain/ports/NasRepository';
import { PppoeRouterGateway } from '@domain/ports/PppoeRouterGateway';
import { RadiusOrchestratorGateway } from '@domain/ports/RadiusOrchestratorGateway';
import { IpPool } from '@domain/entities/network';
import { usableIpsInRange, countAssignedInRange } from '@domain/services/ipMath';
import { AssignedIpsProvider } from '@application/services/AssignedIpsProvider';

/**
 * Lista los pools con sus contadores REALES:
 *   - `totalCount`  = IPs usables del rango [rangeStart, rangeEnd],
 *   - `assignedCount` = cuántas de las IPs ASIGNADAS del NAS del pool caen en ese rango,
 *      ruteando la fuente por `nas.type` (radius_orchestrator → RADIUS; resto → router).
 *
 * La tabla IpAssignment está vacía en prod: la verdad de lo asignado vive en el RADIUS/router.
 * Resiliente por pool: si tras los reintentos el NAS sigue caído, ese pool sale con
 * `assignedCount: null` ("no disponible") y la lista sigue — NUNCA con un 0 que mentiría.
 */
export class ListIpPools {
  constructor(
    private readonly repo: IpNetworkRepository,
    private readonly nasRepo: NasRepository,
    private readonly router: PppoeRouterGateway,
    private readonly orchestrator: RadiusOrchestratorGateway,
  ) {}

  async execute(): Promise<IpPool[]> {
    const pools = await this.repo.findAllPools();
    const provider = new AssignedIpsProvider(this.nasRepo, this.router, this.orchestrator);

    return Promise.all(
      pools.map(async (pool) => {
        const assigned = await provider.forNas(pool.nasId);
        return {
          ...pool,
          totalCount: usableIpsInRange(pool.rangeStart, pool.rangeEnd),
          // `null` = fuente no disponible → contador "no disponible", NO un 0 mentiroso.
          assignedCount: assigned === null
            ? null
            : countAssignedInRange(assigned, pool.rangeStart, pool.rangeEnd),
        };
      }),
    );
  }
}
