import type { ResolveWifiEligibility } from './ResolveWifiEligibility';
import type { WifiManagementPort } from '@domain/ports/WifiManagementPort';
import type { OnuWifiCredentialRepository } from '@domain/ports/OnuWifiCredentialRepository';
import type { PortalWifiStatusDto } from '@application/dto/wifi.dto';

/**
 * wifi-self-service (F0) — `GET /api/portal/wifi/:contractId`.
 *
 * `connectedCount` = hosts con `active=true`. Si `getRouterHosts` falla (la
 * ONU no responde, timeout, lo que sea) el contador cae a `null` — proposal
 * F0: "si el fetch de hosts falla, connectedCount: null — no rompas la
 * pantalla por el contador". La elegibilidad (`eligible`/`reason`) NO se ve
 * afectada por esta falla — son datos independientes.
 *
 * wifi-password-snapshot — `password` por banda sale del snapshot PROPIO
 * (`OnuWifiCredentialRepository`), NUNCA de SmartOLT (nunca la devuelve). A
 * diferencia de `getRouterHosts`, esta lectura es de la MISMA DB que ya
 * resuelve la elegibilidad — si falla, el error genuino propaga (no hay
 * degradación best-effort acá, esa regla es sólo para SmartOLT).
 */
export class GetPortalWifiStatus {
  constructor(
    private readonly resolveEligibility: ResolveWifiEligibility,
    private readonly wifi: Pick<WifiManagementPort, 'getRouterHosts'>,
    private readonly credentials: Pick<OnuWifiCredentialRepository, 'findManyBySn'>,
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

    const saved = await this.credentials.findManyBySn(result.sn);
    const passwordByPort = new Map(saved.map((c) => [c.port, c.password]));

    return {
      eligible: true,
      bands: result.bands.map((b) => ({ band: b.band, ssid: b.ssid, password: passwordByPort.get(b.port) ?? null })),
      connectedCount,
      // EPIC v3 (wifi de visitas) — ADITIVO: siempre las DOS bandas, sin el
      // puerto crudo (la app no conoce puertos SmartOLT, mismo criterio que
      // ocultar la sn). Solo presente cuando eligible.
      guest: {
        bands: result.guest.map((g) => ({ band: g.band, available: g.available, ssid: g.ssid, enabled: g.enabled })),
      },
    };
  }
}
