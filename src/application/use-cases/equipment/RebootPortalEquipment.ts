import type { ResolveEquipmentRebootEligibility } from './ResolveEquipmentRebootEligibility';
import type { OltProvisioningGateway } from '@domain/ports/OltProvisioningGateway';
import { EquipmentNotEligibleError } from '@domain/errors/equipment';

/**
 * portal-equipment-reboot — `POST /api/portal/equipment/:contractId/reboot`.
 *
 * REGLA DURA (mismo criterio que `UpdatePortalWifiBand`, "el server las
 * re-verifica en cada escritura"): esta acción corre
 * `ResolveEquipmentRebootEligibility` COMPLETO de nuevo — NUNCA confía en un
 * estado leído en un GET anterior. Si la ONU dejó de ser elegible entre el GET
 * y el POST (p.ej. desapareció de SmartOLT) la acción se RECHAZA con
 * `EquipmentNotEligibleError`, jamás dispara un reinicio a ciegas.
 */
export class RebootPortalEquipment {
  constructor(
    private readonly resolveEligibility: ResolveEquipmentRebootEligibility,
    private readonly gateway: Pick<OltProvisioningGateway, 'reboot'>,
  ) {}

  async execute(clientId: string, contractId: string): Promise<void> {
    const result = await this.resolveEligibility.execute(clientId, contractId);
    if (!result.eligible) {
      throw new EquipmentNotEligibleError(result.reason);
    }

    await this.gateway.reboot(result.sn);
  }
}
