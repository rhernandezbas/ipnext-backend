import { PppoeService } from '@domain/entities/pppoeService';
import { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import { NasRepository } from '@domain/ports/NasRepository';
import { RadiusOrchestratorGateway } from '@domain/ports/RadiusOrchestratorGateway';
import {
  PppoeServiceNotFoundError,
  NasNotFoundError,
  NasNoPoolError,
} from '@domain/errors/pppoe';

export interface UnpinPppoeIpInput {
  pppoeId: string;
}

/**
 * UnpinPppoeIp (pppoe-pool-ip, Decisión 5) — libera la IP fija de un PPPoE y lo devuelve al
 * pool del NAS.
 *
 * Prerrequisito: el NAS DEBE estar en modo pool (`poolName != null`). Sin pool de respaldo el
 * cliente quedaría sin IP → se rechaza con NasNoPoolError.
 *
 * Flujo:
 *   1. Resuelve PPPoE y NAS.
 *   2. El NAS debe estar en modo pool (poolName != null).
 *   3. Plano de control PRIMERO: `changeFramedIp(username, null)` (RADIUS deja de enviar
 *      Framed-IP-Address → FreeRADIUS asigna del pool en el próximo auth).
 *   4. Recién ahí confirma en DB: `setIpMode('pool', null)`.
 *
 * Consistencia DB↔RADIUS: si el orchestrator falla, la DB NO se toca.
 */
export class UnpinPppoeIp {
  constructor(
    private readonly repo: PppoeServiceRepository,
    private readonly nasRepo: NasRepository,
    private readonly orchestrator: RadiusOrchestratorGateway,
  ) {}

  async execute(input: UnpinPppoeIpInput): Promise<PppoeService> {
    // 1. Resolver PPPoE.
    const svc = await this.repo.findById(input.pppoeId);
    if (!svc) throw new PppoeServiceNotFoundError(input.pppoeId);

    // 2. Resolver NAS.
    const nas = await this.nasRepo.findNasServerById(svc.nasId);
    if (!nas) throw new NasNotFoundError(svc.nasId);

    // 3. El NAS debe estar en modo pool (hay pool al que volver).
    if (nas.poolName == null) throw new NasNoPoolError(nas.id);

    // 4. Plano de control PRIMERO: libera la Framed-IP en el RADIUS.
    await this.orchestrator.changeFramedIp(svc.username, null);

    // 5. Confirmar en DB.
    const updated = await this.repo.setIpMode(svc.id, 'pool', null);
    if (!updated) throw new PppoeServiceNotFoundError(input.pppoeId);
    return updated;
  }
}
