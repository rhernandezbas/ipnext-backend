import type { ResolveWifiEligibility } from './ResolveWifiEligibility';
import type { WifiManagementPort } from '@domain/ports/WifiManagementPort';
import { toPortalWifiDeviceDto, PortalWifiDeviceDto } from '@application/dto/wifi.dto';
import type { WifiEligibilityReason } from '@domain/errors/wifi';

export type ListPortalWifiDevicesResult =
  | { eligible: false; reason: WifiEligibilityReason }
  | { eligible: true; devices: PortalWifiDeviceDto[] };

/**
 * wifi-self-service (F0) — `GET /api/portal/wifi/:contractId/devices`.
 * SIN ip NI mac — la app del cliente no las necesita (menos superficie); el
 * mapeo lo hace `toPortalWifiDeviceDto`, distinto del admin (`toAdminWifiDeviceDto`).
 * Anti-IDOR/elegibilidad: mismos 3 chequeos que el resto (`ResolveWifiEligibility`).
 */
export class ListPortalWifiDevices {
  constructor(
    private readonly resolveEligibility: ResolveWifiEligibility,
    private readonly wifi: Pick<WifiManagementPort, 'getRouterHosts'>,
  ) {}

  async execute(clientId: string, contractId: string): Promise<ListPortalWifiDevicesResult> {
    const result = await this.resolveEligibility.execute(clientId, contractId);
    if (!result.eligible) {
      return { eligible: false, reason: result.reason };
    }

    const hosts = await this.wifi.getRouterHosts(result.sn);
    return { eligible: true, devices: hosts.map(toPortalWifiDeviceDto) };
  }
}
