import { NasRepository } from '@domain/ports/NasRepository';
import { PppoeRouterGateway } from '@domain/ports/PppoeRouterGateway';
import { RadiusOrchestratorGateway } from '@domain/ports/RadiusOrchestratorGateway';

/**
 * Resuelve las IPs ASIGNADAS de un NAS, ruteando por `nas.type` igual que el allocator (FindFreeIp):
 *   - `mikrotik_radius` → RADIUS (orchestrator.listAssignedIps, radreply Framed-IP),
 *   - resto            → router (/ppp secret, remote-address vivos).
 *
 * Pensado para los CONTADORES de Gestión de Red IP (ListIpPools / ListIpNetworks):
 *   - CACHEA por nasId: dos pools del mismo NAS hacen UN solo fetch (no N+1),
 *   - DEGRADA: si el NAS no existe / el router u orchestrator tiran, devuelve `[]`
 *     (un endpoint de listado NUNCA debe romperse porque un NAS esté caído).
 *
 * El RADIUS es GLOBAL (un único `listAssignedIps()` sin target): se cachea bajo una clave
 * sintética para no llamarlo una vez por cada NAS radius. El conteo por rango/CIDR ya
 * recorta la lista global a lo relevante de cada pool/red.
 */
export class AssignedIpsProvider {
  private readonly cache = new Map<string, Promise<string[]>>();
  private static readonly RADIUS_KEY = '__radius_global__';

  constructor(
    private readonly nasRepo: NasRepository,
    private readonly router: PppoeRouterGateway,
    private readonly orchestrator: RadiusOrchestratorGateway,
  ) {}

  /** IPs asignadas del NAS, ruteadas por tipo. `[]` si no hay NAS o la fuente está caída. */
  async forNas(nasId: string | null): Promise<string[]> {
    if (!nasId) return [];

    const nas = await this.nasRepo.findNasServerById(nasId);
    if (!nas) return [];

    const cacheKey = nas.type === 'mikrotik_radius' ? AssignedIpsProvider.RADIUS_KEY : `nas:${nas.id}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const fetch =
      nas.type === 'mikrotik_radius'
        ? this.orchestrator.listAssignedIps()
        : this.router.listAssignedIps({ ipAddress: nas.ipAddress, apiPort: nas.apiPort ?? 8728 });

    // Degradación: cualquier fallo de la fuente → []. Se cachea la promesa (resuelta) para
    // no reintentar dentro de la misma lista.
    const guarded = fetch.catch(() => [] as string[]);
    this.cache.set(cacheKey, guarded);
    return guarded;
  }
}
