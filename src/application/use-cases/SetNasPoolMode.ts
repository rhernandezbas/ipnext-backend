import { NasServer } from '@domain/entities/nas';
import { NasRepository } from '@domain/ports/NasRepository';
import { RadiusOrchestratorGateway } from '@domain/ports/RadiusOrchestratorGateway';
import { NasNotFoundError, RadiusPoolEmptyError } from '@domain/errors/pppoe';

export interface SetNasPoolModeInput {
  nasId: string;
  /** `poolName` no nulo ⟺ marcar el NAS en modo pool. `null` ⟺ desactivar el modo pool. */
  poolName: string | null;
}

/**
 * SetNasPoolMode (pppoe-pool-ip, Decisión 3) — marca/desmarca un NAS en modo pool.
 *
 * Al marcar pool-mode (poolName != null) hace un PRE-CHECK contra el `radippool` del RADIUS
 * (vía `orchestrator.listPools()`, GET /pools): RECHAZA si el pool no existe o no tiene IPs
 * libres → evita "NAS en pool sin pool poblado → cliente sin IP". Desactivar (poolName=null)
 * NO requiere pre-check.
 *
 * Consistencia DB↔RADIUS: el plano de control (orchestrator) se consulta ANTES de tocar la DB.
 * Si el orchestrator falla, `OrchestratorUnreachableError` propaga y la fila del NAS NO cambia.
 */
export class SetNasPoolMode {
  constructor(
    private readonly nasRepo: NasRepository,
    private readonly orchestrator: RadiusOrchestratorGateway,
  ) {}

  async execute(input: SetNasPoolModeInput): Promise<NasServer> {
    const nas = await this.nasRepo.findNasServerById(input.nasId);
    if (!nas) throw new NasNotFoundError(input.nasId);

    // Pre-check SOLO al marcar pool-mode (poolName no nulo). Va antes de la DB.
    if (input.poolName != null) {
      const pools = await this.orchestrator.listPools();
      const pool = pools.find((p) => p.name === input.poolName);
      // Fail-closed: si el pool no existe, `free` no es un número finito (shape inesperado del
      // GET /pools) o no tiene IPs libres → rechazar. `NaN <= 0` es false, así que sin el guard
      // de Number.isFinite un `free` corrupto pasaría como falso-OK y dejaría altas sin IP.
      if (!pool || !Number.isFinite(pool.free) || pool.free <= 0) throw new RadiusPoolEmptyError(input.poolName);
    }

    const updated = await this.nasRepo.updateNasServer(input.nasId, { poolName: input.poolName });
    if (!updated) throw new NasNotFoundError(input.nasId);
    return updated;
  }
}
