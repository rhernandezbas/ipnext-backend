import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type { ContractInventoryRepository } from '@domain/ports/ContractInventoryRepository';
import type { WifiManagementPort } from '@domain/ports/WifiManagementPort';
import type { WifiBandStatus, GuestWifiBandStatus } from '@domain/services/mapWifiPortsToBands';
import { mapWifiPortsToGuest } from '@domain/services/mapWifiPortsToBands';
import { normalizeOnuSerial } from '@domain/services/normalizeOnuSerial';
import { WifiContractNotFoundError, WifiEligibilityReason } from '@domain/errors/wifi';
import { OltProvisioningError } from '@domain/errors/smartolt';

export type WifiEligibilityResult =
  | { eligible: false; reason: WifiEligibilityReason }
  | {
      eligible: true;
      sn: string;
      bands: WifiBandStatus[];
      /**
       * EPIC v3 (wifi de visitas) — estado del puerto de visita por banda,
       * SIEMPRE las dos bandas. Cuando el port no lo informa (fake viejo /
       * status cacheado pre-upgrade), cae al lado SEGURO: ambas no disponibles
       * (`mapWifiPortsToGuest([])`) — la ausencia de dato jamás habilita una
       * escritura.
       */
      guest: GuestWifiBandStatus[];
    };

/**
 * wifi-self-service (F0) — ResolveWifiEligibility: LA autoridad única de la
 * regla "la pantalla Mi WiFi aparece sólo si las TRES condiciones se cumplen"
 * (proposal.md regla 2). Reusada por el GET del portal, el PUT (re-verificación
 * COMPLETA en cada escritura — regla 2, "el server las re-verifica en cada
 * escritura") y el listado de dispositivos.
 *
 * Orden de chequeos (early-return, cada uno es un `reason` de la spec):
 *  1. Anti-IDOR: el `contractId` pedido DEBE pertenecer al `clientId` del
 *     token — ajeno o inexistente -> `WifiContractNotFoundError` (404
 *     indistinguible, mismo criterio que `resolvePortalTicketContract`).
 *  2. `ContractInstalledItem` type='ONU' status='active' con serialNumber no
 *     nulo -> si no hay ninguno, `no_onu`. Un ROUTER activo NO cuenta (fixture
 *     obligatorio del TDD).
 *  3. `getOnuWifiStatus(sn normalizada)`:
 *     - SmartOLT no configurado -> `not_configured` (estado NORMAL, no error:
 *       la app apagada limpia, nunca un 500).
 *     - `found: false` -> `no_onu` (el serial de Prominense no resuelve en
 *       SmartOLT — mismo reason que "sin item", el cliente ve la misma pantalla).
 *     - `tr069Enabled: false` -> `no_tr069`.
 *     - `bands: []` -> `no_wifi_ports`.
 *  4. Todo OK -> `{eligible:true, sn, bands}`.
 */
export class ResolveWifiEligibility {
  constructor(
    private readonly customers: Pick<CustomerRepository, 'listContracts'>,
    private readonly inventory: Pick<ContractInventoryRepository, 'listByContract'>,
    private readonly wifi: Pick<WifiManagementPort, 'getOnuWifiStatus'>,
  ) {}

  async execute(clientId: string, contractId: string): Promise<WifiEligibilityResult> {
    const contracts = await this.customers.listContracts(clientId);
    const owned = contracts.find((c) => c.id === contractId);
    if (!owned) {
      throw new WifiContractNotFoundError();
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
    if (!status.tr069Enabled) {
      return { eligible: false, reason: 'no_tr069' };
    }
    if (status.bands.length === 0) {
      return { eligible: false, reason: 'no_wifi_ports' };
    }

    return { eligible: true, sn, bands: status.bands, guest: status.guest ?? mapWifiPortsToGuest([]) };
  }
}
