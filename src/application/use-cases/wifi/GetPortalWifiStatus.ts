import type { ResolveWifiEligibility } from './ResolveWifiEligibility';
import type { WifiManagementPort } from '@domain/ports/WifiManagementPort';
import type { PortalWifiStatusDto } from '@application/dto/wifi.dto';

/**
 * wifi-self-service (F0) — `GET /api/portal/wifi/:contractId`.
 *
 * `connectedCount` = hosts con `active=true`. Si `getRouterHosts` falla (la
 * ONU no responde, timeout, lo que sea) el contador cae a `null` — proposal
 * F0: "si el fetch de hosts falla, connectedCount: null — no rompas la
 * pantalla por el contador". La elegibilidad (`eligible`/`reason`) NO se ve
 * afectada por esta falla — son datos independientes.
 */
export class GetPortalWifiStatus {
  constructor(
    private readonly resolveEligibility: ResolveWifiEligibility,
    private readonly wifi: Pick<WifiManagementPort, 'getRouterHosts'>,
  ) {}

  async execute(clientId: string, contractId: string): Promise<PortalWifiStatusDto> {
    const result = await this.resolveEligibility.execute(clientId, contractId);
    if (!result.eligible) {
      return { eligible: false, reason: result.reason };
    }

    let connectedCount: number | null;
    try {
      const hosts = await this.wifi.getRouterHosts(result.sn);
      connectedCount = hosts.filter((h) => h.active).length;
    } catch {
      connectedCount = null;
    }

    return {
      eligible: true,
      bands: result.bands.map((b) => ({ band: b.band, ssid: b.ssid })),
      connectedCount,
    };
  }
}
