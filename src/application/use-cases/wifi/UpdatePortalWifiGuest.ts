import type { ResolveWifiEligibility } from './ResolveWifiEligibility';
import type { WifiManagementPort } from '@domain/ports/WifiManagementPort';
import type { OnuWifiCredentialRepository } from '@domain/ports/OnuWifiCredentialRepository';
import { validateWifiSsid, validateWifiPassword } from '@domain/services/validateWifiCredentials';
import { WifiNotEligibleError, GuestBandUnavailableError } from '@domain/errors/wifi';

export interface UpdatePortalWifiGuestInput {
  band: '2.4' | '5';
  ssid: string;
  password: string;
}

/**
 * EPIC v3 (wifi de visitas) — `PUT /api/portal/wifi/:contractId/guest`.
 *
 * Molde `UpdatePortalWifiBand`, con DOS diferencias:
 *  1. El destino es el puerto de VISITA de la banda (wifi_0/2 | wifi_0/6, ver
 *     `mapWifiPortsToGuest`), nunca el principal.
 *  2. La banda puede NO tener puerto de visita en el template "ONU type"
 *     (evidencia HWTCA92F96B1 2026-08-03: sin NINGÚN puerto 5GHz) ->
 *     `GuestBandUnavailableError` (409) y el gateway JAMÁS se toca.
 *
 * REGLA DURA (proposal wifi-self-service, regla 2): re-verifica la elegibilidad
 * ENTERA en cada escritura — nunca confía en un estado leído en un GET previo.
 * `setWifiBand` fuerza WPA2 a nivel adapter (jamás Open-system).
 *
 * wifi-password-snapshot — tras el set EXITOSO, upsert best-effort del
 * snapshot (`updatedBy: 'portal'`), mismo criterio que el update principal:
 * el equipo YA cambió, un 500 del snapshot mentiría sobre un cambio aplicado.
 */
export class UpdatePortalWifiGuest {
  constructor(
    private readonly resolveEligibility: ResolveWifiEligibility,
    private readonly wifi: Pick<WifiManagementPort, 'setWifiBand'>,
    private readonly credentials: Pick<OnuWifiCredentialRepository, 'upsert'>,
  ) {}

  async execute(clientId: string, contractId: string, input: UpdatePortalWifiGuestInput): Promise<void> {
    validateWifiSsid(input.ssid);
    validateWifiPassword(input.password);

    // Anti-IDOR + las 3 condiciones de elegibilidad, re-corridas ENTERAS.
    const result = await this.resolveEligibility.execute(clientId, contractId);
    if (!result.eligible) {
      throw new WifiNotEligibleError(result.reason);
    }

    const target = result.guest.find((g) => g.band === input.band);
    if (!target || !target.available) {
      throw new GuestBandUnavailableError(input.band);
    }

    await this.wifi.setWifiBand(result.sn, { port: target.port, ssid: input.ssid, password: input.password });

    try {
      await this.credentials.upsert({
        sn: result.sn,
        port: target.port,
        ssid: input.ssid,
        password: input.password,
        updatedBy: 'portal',
      });
    } catch (err) {
      console.warn('[UpdatePortalWifiGuest] snapshot de password falló (best-effort — el equipo ya cambió):', err);
    }
  }
}
