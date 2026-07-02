import { PppoeService } from '@domain/entities/pppoeService';
import { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import { NasRepository } from '@domain/ports/NasRepository';
import { RadiusOrchestratorGateway } from '@domain/ports/RadiusOrchestratorGateway';
import { routesViaOrchestrator } from '@domain/entities/nas';
import {
  PppoeServiceNotFoundError,
  NasNotFoundError,
  InvalidIpFormatError,
  IpAlreadyTakenError,
  OrchestratorUnreachableError,
  PppoePendingInstallError,
} from '@domain/errors/pppoe';

export interface PinPppoeIpInput {
  pppoeId: string;
  ip: string;
}

/** Valida un IPv4 en notación dotted-decimal (4 octetos 0-255, sin ceros raros). */
function isValidIpv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    if (!/^\d+$/.test(p)) return false;
    const n = Number(p);
    return n >= 0 && n <= 255;
  });
}

/**
 * PinPppoeIp (pppoe-pool-ip, Decisión 5) — pinea una IP fija a un PPPoE en el RADIUS.
 *
 * Flujo:
 *   1. Valida el formato IPv4 (sin tocar nada si es inválido).
 *   2. Resuelve PPPoE y NAS.
 *   3. El NAS debe rutear via orchestrator (la IP fija vive en radreply Framed-IP-Address).
 *   4. La IP no debe estar tomada por OTRO usuario (cruza `listAssignedIps()`).
 *   5. Plano de control PRIMERO: `changeFramedIp(username, ip)`.
 *   6. Recién ahí confirma en DB: `setIpMode('fixed', ip)`.
 *
 * Consistencia DB↔RADIUS: si el orchestrator falla, la DB NO se toca (nunca un OK mentiroso).
 */
export class PinPppoeIp {
  constructor(
    private readonly repo: PppoeServiceRepository,
    private readonly nasRepo: NasRepository,
    private readonly orchestrator: RadiusOrchestratorGateway,
  ) {}

  async execute(input: PinPppoeIpInput): Promise<PppoeService> {
    // 1. Formato IPv4 — error de dominio antes de tocar RADIUS o DB.
    // TODO(go-live): validar que la IP esté dentro de un rango gestionado (IpNetwork) — spec SHALL; requiere inyectar IpNetworkRepository
    if (!isValidIpv4(input.ip)) throw new InvalidIpFormatError(input.ip);

    // 2. Resolver PPPoE.
    const svc = await this.repo.findById(input.pppoeId);
    if (!svc) throw new PppoeServiceNotFoundError(input.pppoeId);

    // 3. Resolver NAS.
    //    pppoe-preprovision (REQ-PRE-4): un pendiente (nasId null) no tiene pool contra el cual
    //    pinear — no operable hasta la adopción.
    if (svc.nasId === null) throw new PppoePendingInstallError(svc.id);
    const nas = await this.nasRepo.findNasServerById(svc.nasId);
    if (!nas) throw new NasNotFoundError(svc.nasId);

    // 4. La IP fija solo se pinea en RADIUS (radreply Framed-IP). NAS no-RADIUS → no soportado.
    if (!routesViaOrchestrator(nas.type)) {
      throw new OrchestratorUnreachableError(
        nas.ipAddress,
        `El NAS ${nas.id} (type=${nas.type}) no rutea via orchestrator — pin de IP no soportado`,
      );
    }

    // 5. La IP no debe estar tomada por OTRO usuario (radreply Framed-IP del RADIUS).
    //    Excluimos la IP ACTUAL del propio servicio: re-pinear un servicio a SU MISMA IP
    //    (que ya figura en listAssignedIps) NO es un conflicto → evita el falso 409 en el re-pin.
    const taken = (await this.orchestrator.listAssignedIps()).filter((ip) => ip !== svc.remoteAddress);
    if (taken.includes(input.ip)) throw new IpAlreadyTakenError(input.ip);

    // 6. Plano de control PRIMERO.
    await this.orchestrator.changeFramedIp(svc.username, input.ip);

    // 7. Confirmar en DB.
    const updated = await this.repo.setIpMode(svc.id, 'fixed', input.ip);
    if (!updated) throw new PppoeServiceNotFoundError(input.pppoeId);
    return updated;
  }
}
