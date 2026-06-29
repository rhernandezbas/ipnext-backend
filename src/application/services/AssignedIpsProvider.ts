import { NasRepository } from '@domain/ports/NasRepository';
import { PppoeRouterGateway } from '@domain/ports/PppoeRouterGateway';
import { RadiusOrchestratorGateway } from '@domain/ports/RadiusOrchestratorGateway';
import { routesViaOrchestrator } from '@domain/entities/nas';

/**
 * Resuelve las IPs ASIGNADAS de un NAS, ruteando por `nas.type` igual que el allocator (FindFreeIp):
 *   - `radius_orchestrator` → RADIUS (orchestrator.listAssignedIps, radreply Framed-IP),
 *   - resto            → router (/ppp secret, remote-address vivos).
 *
 * Pensado para los CONTADORES de Gestión de Red IP (ListIpPools / ListIpNetworks):
 *   - CACHEA por nasId: dos pools del mismo NAS hacen UN solo fetch (no N+1),
 *   - RESILIENTE: el fetch a la fuente se REINTENTA con backoff para absorber el hipo
 *     transitorio (el orchestrator responde en 27-55ms, pero un timeout puntual tiraba el
 *     contador a 0). Si tras los reintentos la fuente SIGUE caída → devuelve `null`
 *     ("no disponible"), NO `[]`. Un 0-por-fallo es indistinguible de un 0-real: el contador
 *     MENTIRÍA. El caller propaga `null` a los counts (el FE muestra "—").
 *   - `[]` se reserva para el 0 REAL: NAS inexistente o sin nasId (no hay fuente que consultar).
 *
 * El RADIUS es GLOBAL (un único `listAssignedIps()` sin target): se cachea bajo una clave
 * sintética para no llamarlo una vez por cada NAS radius. El conteo por rango/CIDR ya
 * recorta la lista global a lo relevante de cada pool/red.
 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class AssignedIpsProvider {
  private readonly cache = new Map<string, Promise<string[] | null>>();
  private static readonly RADIUS_KEY = '__radius_global__';
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly perAttemptTimeoutMs: number;

  constructor(
    private readonly nasRepo: NasRepository,
    private readonly router: PppoeRouterGateway,
    private readonly orchestrator: RadiusOrchestratorGateway,
    opts: { retries?: number; backoffMs?: number; perAttemptTimeoutMs?: number } = {},
  ) {
    this.retries = opts.retries ?? 2;
    this.backoffMs = opts.backoffMs ?? 150;
    // Acota la latencia por intento: sin esto, `retries` multiplicaba el timeout del gateway
    // (axios RADIUS 6s, router SSH 15s) → peor caso ×3 colgaba /ip-pools y /ip-networks.
    // 0/undefined = sin timeout extra (el gateway manda). Default 4s.
    this.perAttemptTimeoutMs = opts.perAttemptTimeoutMs ?? 4000;
  }

  /**
   * IPs asignadas del NAS, ruteadas por tipo.
   *   - `[]`   → no hay NAS / nasId nulo (0 REAL, no es fallo).
   *   - `null` → la fuente sigue caída tras los reintentos ("no disponible").
   *   - `string[]` → las IPs asignadas.
   */
  async forNas(nasId: string | null): Promise<string[] | null> {
    if (!nasId) return [];

    const nas = await this.nasRepo.findNasServerById(nasId);
    if (!nas) return [];

    const cacheKey = routesViaOrchestrator(nas.type) ? AssignedIpsProvider.RADIUS_KEY : `nas:${nas.id}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const doFetch = (): Promise<string[]> =>
      routesViaOrchestrator(nas.type)
        ? this.orchestrator.listAssignedIps()
        : this.router.listAssignedIps({ ipAddress: nas.ipAddress, apiPort: nas.apiPort ?? 8728 });

    // Se cachea la PROMESA (aún sin resolver) para que pools/redes del mismo NAS compartan el
    // mismo fetch+retry (no N+1 ni reintentos duplicados dentro de la misma lista).
    const guarded = this.fetchWithRetry(doFetch);
    this.cache.set(cacheKey, guarded);
    return guarded;
  }

  /** Reintenta `doFetch` hasta `retries` veces con backoff `backoffMs * (intento+1)`. `null` si todos fallan. */
  private async fetchWithRetry(doFetch: () => Promise<string[]>): Promise<string[] | null> {
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await this.withTimeout(doFetch);
      } catch {
        if (attempt < this.retries) await sleep(this.backoffMs * (attempt + 1));
      }
    }
    return null; // fuente caída tras agotar los reintentos → "no disponible"
  }

  /**
   * Corre `doFetch` con un timeout duro por intento: si el gateway no responde en
   * `perAttemptTimeoutMs`, rechaza (cuenta como fallo → reintenta). Limpia el timer apenas el
   * race se resuelve (gane el fetch o el timeout) para no dejar timers colgando. Si el timeout
   * está en 0/undefined → devuelve el fetch directo (sin acotar).
   */
  private withTimeout(doFetch: () => Promise<string[]>): Promise<string[]> {
    const ms = this.perAttemptTimeoutMs;
    if (!ms) return doFetch();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`assigned-ips fetch excedió ${ms}ms`)), ms);
    });
    return Promise.race([doFetch(), timeout]).finally(() => clearTimeout(timer));
  }
}
