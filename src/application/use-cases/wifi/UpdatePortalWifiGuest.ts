import type { ResolveWifiEligibility } from './ResolveWifiEligibility';
import type { WifiManagementPort } from '@domain/ports/WifiManagementPort';
import type { OnuWifiCredentialRepository } from '@domain/ports/OnuWifiCredentialRepository';
import type { WifiGuestIntentRepository } from '@domain/ports/WifiGuestIntentRepository';
import type { PortalGuestPendingDto } from '@application/dto/wifi.dto';
import { validateWifiSsid, validateWifiPassword } from '@domain/services/validateWifiCredentials';
import { isWifiGuestIntentInProgress } from '@domain/services/wifiGuestIntentPolicy';
import { WifiNotEligibleError, GuestBandUnavailableError, GuestChangePendingError } from '@domain/errors/wifi';

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
 *
 * wifi-guest-pending — el alta tarda ~2 min en llegar al equipo (TR-069 +
 * cache) y la app dejaba tocar el botón de nuevo. Ahora:
 *  - Intent EN CURSO (edad < 10 min) para esta ONU -> `GuestChangePendingError`
 *    (409) SIN tocar el gateway; 'unconfirmed' (>= 10 min) permite reintentar.
 *  - Tras el write exitoso se persiste el intent ('creating') y se devuelve
 *    `guestPending` — el GET lo evalúa lazy. El write al intent es best-effort
 *    (mismo criterio que el snapshot: el equipo YA cambió); si falla, se
 *    degrada al comportamiento viejo (sin pending) en el GET.
 *  - Si SmartOLT rechaza el write, NO se crea intent (comportamiento de hoy).
 */
export class UpdatePortalWifiGuest {
  constructor(
    private readonly resolveEligibility: ResolveWifiEligibility,
    private readonly wifi: Pick<WifiManagementPort, 'setWifiBand'>,
    private readonly credentials: Pick<OnuWifiCredentialRepository, 'upsert'>,
    private readonly intents: WifiGuestIntentRepository,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async execute(clientId: string, contractId: string, input: UpdatePortalWifiGuestInput): Promise<PortalGuestPendingDto> {
    validateWifiSsid(input.ssid);
    validateWifiPassword(input.password);

    // Anti-IDOR + las 3 condiciones de elegibilidad, re-corridas ENTERAS.
    const result = await this.resolveEligibility.execute(clientId, contractId);
    if (!result.eligible) {
      throw new WifiNotEligibleError(result.reason);
    }

    // wifi-guest-pending — un cambio en vuelo congela TODOS los writes guest
    // de la ONU (el contrato expone UN solo guestPending, sin banda).
    const existing = await this.intents.findBySn(result.sn);
    if (existing && isWifiGuestIntentInProgress(existing, this.now())) {
      throw new GuestChangePendingError();
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

    const since = new Date(this.now()).toISOString();
    try {
      await this.intents.replace({ sn: result.sn, action: 'creating', port: target.port, since });
    } catch (err) {
      console.warn('[UpdatePortalWifiGuest] persistencia del intent falló (best-effort — el equipo ya cambió):', err);
    }

    return { action: 'creating', since, status: 'in_progress' };
  }
}
