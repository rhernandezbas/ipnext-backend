import type { ResolveWifiEligibility } from './ResolveWifiEligibility';
import type { WifiManagementPort } from '@domain/ports/WifiManagementPort';
import { WifiNotEligibleError, GuestBandUnavailableError } from '@domain/errors/wifi';

/**
 * EPIC v3 (wifi de visitas) — `POST /api/portal/wifi/:contractId/guest/disable`.
 *
 * Misma disciplina que `UpdatePortalWifiGuest` (re-verificación ENTERA de la
 * elegibilidad en cada escritura + banda sin puerto de visita ->
 * `GuestBandUnavailableError` sin tocar el gateway), pero aplica
 * `shutdownWifiPort` (POST onu/shutdown_wifi_port — apaga ESE puerto; el
 * adapter invalida la cache del wifi status para que el próximo GET vea
 * `enabled:false`).
 */
export class DisablePortalWifiGuest {
  constructor(
    private readonly resolveEligibility: ResolveWifiEligibility,
    private readonly wifi: Pick<WifiManagementPort, 'shutdownWifiPort'>,
  ) {}

  async execute(clientId: string, contractId: string, band: '2.4' | '5'): Promise<void> {
    const result = await this.resolveEligibility.execute(clientId, contractId);
    if (!result.eligible) {
      throw new WifiNotEligibleError(result.reason);
    }

    const target = result.guest.find((g) => g.band === band);
    if (!target || !target.available) {
      throw new GuestBandUnavailableError(band);
    }

    await this.wifi.shutdownWifiPort(result.sn, target.port);
  }
}
