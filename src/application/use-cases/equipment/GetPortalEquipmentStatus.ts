import type { ResolveEquipmentRebootEligibility } from './ResolveEquipmentRebootEligibility';
import type { PortalEquipmentStatusDto } from '@application/dto/equipment.dto';

/**
 * portal-equipment-reboot — `GET /api/portal/equipment/:contractId`.
 *
 * Solo mapea el resultado de `ResolveEquipmentRebootEligibility` al DTO
 * público del portal (descarta `sn` — el cliente nunca ve el serial crudo,
 * mismo criterio que `GetPortalWifiStatus` con la sn interna).
 */
export class GetPortalEquipmentStatus {
  constructor(private readonly resolveEligibility: ResolveEquipmentRebootEligibility) {}

  async execute(clientId: string, contractId: string): Promise<PortalEquipmentStatusDto> {
    const result = await this.resolveEligibility.execute(clientId, contractId);
    if (!result.eligible) {
      return { eligible: false, reason: result.reason };
    }
    return { eligible: true, online: result.online, model: result.model };
  }
}
