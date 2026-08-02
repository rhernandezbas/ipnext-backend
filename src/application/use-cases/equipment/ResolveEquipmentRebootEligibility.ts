import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type { ContractInventoryRepository } from '@domain/ports/ContractInventoryRepository';
import type { WifiManagementPort } from '@domain/ports/WifiManagementPort';
import { normalizeOnuSerial } from '@domain/services/normalizeOnuSerial';
import { EquipmentContractNotFoundError, EquipmentRebootReason } from '@domain/errors/equipment';
import { OltProvisioningError } from '@domain/errors/smartolt';

export type EquipmentRebootEligibilityResult =
  | { eligible: false; reason: EquipmentRebootReason }
  | { eligible: true; sn: string; online: boolean; model: string | null };

/**
 * portal-equipment-reboot — ResolveEquipmentRebootEligibility: la autoridad
 * única de "el cliente puede reiniciar SU equipo desde la app". Extiende el
 * trabajo de wifi-self-service (`ResolveWifiEligibility`) — reusa el mismo
 * `WifiManagementPort.getOnuWifiStatus` (misma cache 60s) para saber si el
 * serial resuelve en SmartOLT — pero NO lo duplica: el reboot va por OMCI, no
 * por TR-069, así que la elegibilidad es MÁS AMPLIA.
 *
 * DIFERENCIA CLAVE con `ResolveWifiEligibility`:
 *  - WiFi exige contrato + ONU activa + TR-069 Enabled + al menos un puerto
 *    WiFi habilitado (4 condiciones) — porque cambiar el SSID/pass necesita
 *    hablar TR-069 con el router.
 *  - Reboot exige SOLO contrato + ONU activa cuyo serial resuelve en SmartOLT
 *    (found:true) — 2 condiciones. `tr069Enabled`/`bands` NI SE MIRAN: un
 *    reinicio OMCI anda incluso en un bridge sin WiFi propio y sin TR-069
 *    habilitado (el 60% de los cortes se resuelve así, sin depender de que el
 *    router hable TR-069).
 *
 * Orden de chequeos (early-return, cada uno es un `reason` de la spec):
 *  1. Anti-IDOR: el `contractId` pedido DEBE pertenecer al `clientId` del
 *     token — ajeno o inexistente -> `EquipmentContractNotFoundError` (404
 *     indistinguible, mismo criterio que `ResolveWifiEligibility`).
 *  2. `ContractInstalledItem` type='ONU' status='active' con serialNumber no
 *     nulo -> si no hay ninguno, `no_onu`. Un ROUTER activo NO cuenta.
 *  3. `getOnuWifiStatus(sn normalizada)`:
 *     - SmartOLT no configurado -> `not_configured` (estado NORMAL, no error).
 *     - `found: false` -> `no_onu` (mismo reason que "sin item").
 *  4. Todo OK -> `{eligible:true, sn, online, model}`.
 */
export class ResolveEquipmentRebootEligibility {
  constructor(
    private readonly customers: Pick<CustomerRepository, 'listContracts'>,
    private readonly inventory: Pick<ContractInventoryRepository, 'listByContract'>,
    private readonly wifi: Pick<WifiManagementPort, 'getOnuWifiStatus'>,
  ) {}

  async execute(clientId: string, contractId: string): Promise<EquipmentRebootEligibilityResult> {
    const contracts = await this.customers.listContracts(clientId);
    const owned = contracts.find((c) => c.id === contractId);
    if (!owned) {
      throw new EquipmentContractNotFoundError();
    }

    const items = await this.inventory.listByContract(contractId);
    const onuItem = items.find((i) => i.type === 'ONU' && i.status === 'active' && !!i.serialNumber);
    if (!onuItem || !onuItem.serialNumber) {
      return { eligible: false, reason: 'no_onu' };
    }

    const sn = normalizeOnuSerial(onuItem.serialNumber);

    let status;
    try {
      status = await this.wifi.getOnuWifiStatus(sn);
    } catch (err) {
      if (err instanceof OltProvisioningError && err.reason === 'not_configured') {
        return { eligible: false, reason: 'not_configured' };
      }
      throw err;
    }

    if (!status.found) {
      return { eligible: false, reason: 'no_onu' };
    }

    return { eligible: true, sn, online: status.online, model: status.onuType };
  }
}
