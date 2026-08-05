import type { ResolveWifiEligibility } from './ResolveWifiEligibility';
import type { WifiManagementPort } from '@domain/ports/WifiManagementPort';
import type { WifiGuestIntentRepository } from '@domain/ports/WifiGuestIntentRepository';
import type { PortalGuestPendingDto } from '@application/dto/wifi.dto';
import { isWifiGuestIntentInProgress } from '@domain/services/wifiGuestIntentPolicy';
import { WifiNotEligibleError, GuestBandUnavailableError, GuestChangePendingError } from '@domain/errors/wifi';

/**
 * EPIC v3 (wifi de visitas) — `POST /api/portal/wifi/:contractId/guest/disable`.
 *
 * Misma disciplina que `UpdatePortalWifiGuest` (re-verificación ENTERA de la
 * elegibilidad en cada escritura + banda sin puerto de visita ->
 * `GuestBandUnavailableError` sin tocar el gateway), pero aplica
 * `shutdownWifiPort` (POST onu/shutdown_wifi_port — apaga ESE puerto; el
 * adapter invalida la cache del wifi status para que el próximo GET vea
 * `enabled:false`).
 *
 * wifi-guest-pending — en el EG8041V5 el shutdown es aceptado por SmartOLT
 * (su DB queda Disabled) pero el push TR-069 SE PIERDE: el SSID sigue
 * emitiendo (verificado EN VIVO 2026-08-05, HWTCA92F96B1). Por eso la baja
 * deja un intent ('deleting') que el GET del portal evalúa lazy: verificación
 * contra la lectura VIVA + re-push único + 'unconfirmed' a los 10 min. Igual
 * que el PUT guest: intent EN CURSO -> `GuestChangePendingError` (409) sin
 * tocar el gateway; SmartOLT rechaza -> NO se crea intent; el write del intent
 * es best-effort (el equipo ya recibió la orden).
 */
export class DisablePortalWifiGuest {
  constructor(
    private readonly resolveEligibility: ResolveWifiEligibility,
    private readonly wifi: Pick<WifiManagementPort, 'shutdownWifiPort'>,
    private readonly intents: WifiGuestIntentRepository,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async execute(clientId: string, contractId: string, band: '2.4' | '5'): Promise<PortalGuestPendingDto> {
    const result = await this.resolveEligibility.execute(clientId, contractId);
    if (!result.eligible) {
      throw new WifiNotEligibleError(result.reason);
    }

    // Solo bloquea un intent de ESTE contrato (uno ajeno = ONT re-provisionado,
    // huérfano: el replace lo pisa). RESIDUO ACEPTADO: check-then-act sin
    // transacción — dos devices simultáneos del mismo cliente pueden pasar
    // ambos el check y pushear ambos; el último replace gana y el daño es un
    // push extra. Serializar por sn no paga con el tráfico real del portal
    // (mismo razonamiento documentado en UpdatePortalWifiGuest).
    const existing = await this.intents.findBySn(result.sn);
    if (existing && existing.contractId === contractId && isWifiGuestIntentInProgress(existing, this.now())) {
      throw new GuestChangePendingError();
    }

    const target = result.guest.find((g) => g.band === band);
    if (!target || !target.available) {
      throw new GuestBandUnavailableError(band);
    }

    await this.wifi.shutdownWifiPort(result.sn, target.port);

    const since = new Date(this.now()).toISOString();
    try {
      await this.intents.replace({ sn: result.sn, contractId, action: 'deleting', port: target.port, since });
    } catch (err) {
      console.warn('[DisablePortalWifiGuest] persistencia del intent falló (best-effort — la orden ya se envió):', err);
    }

    return { action: 'deleting', since, status: 'in_progress' };
  }
}
