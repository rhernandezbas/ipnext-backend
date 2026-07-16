import type { ContractRepository, ContractNetworkAssignmentResult } from '@domain/ports/ContractRepository';
import type { NetworkSiteRepository } from '@domain/ports/NetworkSiteRepository';
import type { AccessPointRepository } from '@domain/ports/AccessPointRepository';
import { ContractNotFoundError } from '@domain/errors/contractServices';
import {
  NetworkSiteNotFoundError,
  AccessPointNotFoundError,
  AccessPointRetiredError,
  AccessPointNotInSiteError,
} from '@domain/errors/networkAssignment';

/**
 * `undefined` = no tocar ese campo. `null` = limpiar explícitamente (semántica PATCH parcial,
 * design §9.1). Al menos una key presente se exige en la ruta (zod, 400) — el use case no lo
 * revalida.
 */
export interface SetContractNetworkAssignmentCommand {
  contractId: string;
  networkSiteId?: string | null;
  accessPointId?: string | null;
}

/**
 * contract-node-ap-auto-assign (Fase B) — picker manual: asigna/limpia el nodo y/o AP de un
 * contrato a mano, para lo que la red NO ve (fibra, PPPoE sin match). Molde:
 * `UpdateContractLocation`.
 *
 * Invariante de coherencia del par persistido (design §9.1):
 * `accessPointId != null ⇒ networkSiteId === ap.networkSiteId`. Reglas:
 *   - Solo `accessPointId` (site omitido) → autocompleta el site desde el AP.
 *   - Solo `networkSiteId` (AP omitido) → si el AP actual del contrato no pertenece al site
 *     nuevo, se limpia; si pertenece, se conserva.
 *   - `networkSiteId: null` explícito → limpia AMBOS (desasignar el nodo desasigna el AP),
 *     SIEMPRE, sin importar qué venga en `accessPointId` en el mismo call.
 *   - `accessPointId: null` explícito (site omitido) → limpia SOLO el AP; el site queda.
 */
export class SetContractNetworkAssignment {
  constructor(
    private readonly contractRepo: ContractRepository,
    private readonly networkSiteRepo: NetworkSiteRepository,
    private readonly accessPointRepo: AccessPointRepository,
  ) {}

  async execute(cmd: SetContractNetworkAssignmentCommand): Promise<ContractNetworkAssignmentResult> {
    const [current] = await this.contractRepo.getNetworkAssignments([cmd.contractId]);
    if (!current) throw new ContractNotFoundError(cmd.contractId);

    // Validaciones de existencia (design §9.1, en el orden de la tabla).
    let site: { id: string } | null = null;
    if (cmd.networkSiteId !== undefined && cmd.networkSiteId !== null) {
      site = await this.networkSiteRepo.findById(cmd.networkSiteId);
      if (!site) throw new NetworkSiteNotFoundError(cmd.networkSiteId);
    }

    let ap: { id: string; networkSiteId: string | null; missingSince: Date | null } | null = null;
    if (cmd.accessPointId !== undefined && cmd.accessPointId !== null) {
      ap = await this.accessPointRepo.findById(cmd.accessPointId);
      if (!ap) throw new AccessPointNotFoundError(cmd.accessPointId);
      if (ap.missingSince !== null) throw new AccessPointRetiredError(cmd.accessPointId);
    }

    if (site && ap && ap.networkSiteId !== site.id) {
      throw new AccessPointNotInSiteError(ap.id, site.id);
    }

    // Derivación del par target — el par persistido SIEMPRE queda coherente.
    let targetNetworkSiteId: string | null;
    let targetAccessPointId: string | null;

    if (cmd.networkSiteId === null) {
      // networkSiteId:null explícito gana SIEMPRE — desasignar el nodo desasigna el AP.
      targetNetworkSiteId = null;
      targetAccessPointId = null;
    } else if (ap) {
      // Asignando un AP concreto: par coherente (ya validado contra `site` si vino).
      targetAccessPointId = ap.id;
      targetNetworkSiteId = ap.networkSiteId;
    } else if (cmd.accessPointId === null) {
      // accessPointId:null explícito (AP omitido del par, site queda si no vino uno nuevo).
      targetAccessPointId = null;
      targetNetworkSiteId = site ? site.id : current.networkSiteId;
    } else if (site) {
      // Solo mueve el site — limpia el AP actual si ya no pertenece al site nuevo.
      targetNetworkSiteId = site.id;
      if (current.accessPointId) {
        const currentAp = await this.accessPointRepo.findById(current.accessPointId);
        targetAccessPointId = currentAp && currentAp.networkSiteId === site.id ? current.accessPointId : null;
      } else {
        targetAccessPointId = null;
      }
    } else {
      // Ninguna key presente (defensivo — la ruta ya exige al menos una vía zod).
      targetNetworkSiteId = current.networkSiteId;
      targetAccessPointId = current.accessPointId;
    }

    if (targetNetworkSiteId === current.networkSiteId && targetAccessPointId === current.accessPointId) {
      return { id: current.id, networkSiteId: current.networkSiteId, accessPointId: current.accessPointId };
    }

    const updated = await this.contractRepo.updateNetworkAssignment(cmd.contractId, {
      networkSiteId: targetNetworkSiteId,
      accessPointId: targetAccessPointId,
    });
    if (!updated) throw new ContractNotFoundError(cmd.contractId);
    return updated;
  }
}
