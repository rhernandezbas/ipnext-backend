import type { ResolveWifiEligibility } from './ResolveWifiEligibility';
import type { WifiManagementPort } from '@domain/ports/WifiManagementPort';
import type { OnuWifiCredentialRepository } from '@domain/ports/OnuWifiCredentialRepository';
import type { WifiGuestIntentRepository, WifiGuestIntent } from '@domain/ports/WifiGuestIntentRepository';
import type { PortalWifiStatusDto, PortalGuestPendingDto } from '@application/dto/wifi.dto';
import { wifiPortWlanIndex } from '@domain/services/mapWifiPortsToBands';
import {
  isWifiGuestIntentInProgress,
  wifiGuestIntentAgeMs,
  WIFI_GUEST_RETRY_AFTER_MS,
} from '@domain/services/wifiGuestIntentPolicy';

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
 *
 * wifi-guest-pending — evaluación LAZY del intent de cambio de la red de
 * visitas (sin cron): ver `evaluateGuestPending`. La lectura del intent es de
 * NUESTRA DB (mismo criterio que el snapshot: si falla, propaga); lo único
 * best-effort es lo que toca SmartOLT (verificación viva + re-push).
 */
export class GetPortalWifiStatus {
  constructor(
    private readonly resolveEligibility: ResolveWifiEligibility,
    private readonly wifi: Pick<WifiManagementPort, 'getRouterHosts' | 'getOnlineWifiMacs' | 'shutdownWifiPort'>,
    private readonly credentials: Pick<OnuWifiCredentialRepository, 'findManyBySn'>,
    private readonly intents: WifiGuestIntentRepository,
    private readonly now: () => number = () => Date.now(),
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

    const guestPending = await this.evaluateGuestPending(result.sn, contractId);

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
      // wifi-guest-pending — ADITIVO y opcional: la clave se OMITE (no
      // undefined) cuando no hay cambio en vuelo — shape-freeze del contrato.
      ...(guestPending ? { guestPending } : {}),
    };
  }

  /**
   * wifi-guest-pending — evaluación lazy del intent (sin cron; corre en cada
   * GET mientras el intent exista — la verificación viva está cacheada 60s en
   * el adapter, rate limit 1000/h):
   *
   *  - 'creating', edad < 10 min  -> 'in_progress' (UX del alta: TR-069 tarda
   *    ~2 min; nunca se verifica — `set_wifi_port_lan` SÍ aplica en vivo,
   *    asimetría medida 2026-08-04).
   *  - 'creating', edad >= 10 min -> borrar el intent: la DB de SmartOLT ya
   *    refleja el alta (este mismo GET la lee) — el pending del alta es UX
   *    puramente temporal.
   *  - 'deleting', edad < 10 min  -> 'in_progress'; si edad > 3 min y todavía
   *    sin retriedAt, verificar la lectura VIVA: ¿quedan MACs en el índice
   *    WLAN del puerto guest? Si SIGUEN -> re-push `shutdown_wifi_port` UNA
   *    vez y sellar retriedAt.
   *  - 'deleting', edad >= 10 min -> verificar: MACs siguen -> 'unconfirmed'
   *    (intent se MANTIENE, NO más retries — la app permite reintentar);
   *    sin MACs -> borrar el intent. SEÑAL ASIMÉTRICA a propósito: "sin MACs
   *    en el índice" NO prueba que la radio esté apagada (puede no tener
   *    clientes asociados) — pero es la única lectura viva disponible
   *    (SmartOLT no expone el estado real de la radio); con MACs la mentira
   *    está PROBADA, sin MACs asumimos aplicado y cerramos.
   *
   * Toda falla de SmartOLT en la verificación/re-push degrada SIN romper el
   * GET: 'in_progress'/'unconfirmed' según edad.
   */
  private async evaluateGuestPending(sn: string, contractId: string): Promise<PortalGuestPendingDto | undefined> {
    const intent = await this.intents.findBySn(sn);
    if (!intent) return undefined;

    // Intent HUÉRFANO: el ONT se re-provisionó a OTRO contrato (reuso rutinario
    // del parque) — el dueño nuevo NO hereda el nag 'unconfirmed' ni el poll de
    // un cambio que no ordenó. Se borra en silencio, sin verificar nada.
    if (intent.contractId !== contractId) {
      await this.intents.deleteBySn(sn);
      return undefined;
    }

    const nowMs = this.now();
    const inProgress = isWifiGuestIntentInProgress(intent, nowMs);

    if (intent.action === 'creating') {
      if (!inProgress) {
        await this.intents.deleteBySn(sn);
        return undefined;
      }
      return { action: 'creating', since: intent.since, status: 'in_progress' };
    }

    // action === 'deleting'
    if (!inProgress) {
      let stillEmitting: boolean;
      try {
        stillEmitting = await this.guestWlanHasOnlineMacs(sn, intent);
      } catch {
        // SmartOLT caído: no se puede confirmar NI refutar — 'unconfirmed'
        // honesto, sin tirar el GET; el intent queda para el próximo intento.
        return { action: 'deleting', since: intent.since, status: 'unconfirmed' };
      }
      if (stillEmitting) {
        return { action: 'deleting', since: intent.since, status: 'unconfirmed' };
      }
      await this.intents.deleteBySn(sn);
      return undefined;
    }

    if (wifiGuestIntentAgeMs(intent, nowMs) > WIFI_GUEST_RETRY_AFTER_MS && intent.retriedAt === null) {
      try {
        if (await this.guestWlanHasOnlineMacs(sn, intent)) {
          // AT-MOST-ONCE: el sello va ANTES del push. Si fuera al revés y el
          // push saliera pero markRetried fallara (blip de DB, P2025 por
          // reemplazo concurrente), retriedAt quedaría null y el poll de 30s
          // de la app re-pushearía en CADA GET (~14 POSTs en la ventana
          // 3-10 min). Con el sello primero, el peor caso es UN push perdido
          // (sellado pero nunca enviado) — preferimos un push perdido a una
          // tormenta; a los 10 min la verificación decide igual (unconfirmed
          // permite reintentar a mano).
          await this.intents.markRetried(intent.id, new Date(nowMs).toISOString());
          await this.wifi.shutdownWifiPort(sn, intent.port);
        }
      } catch (err) {
        // Verificación, sello o re-push caídos: el GET jamás rompe por esto.
        // Si falló el SELLO, el push ni se intentó (nunca un push sin sellar);
        // si falló la verificación, el próximo GET en ventana reintenta.
        console.warn('[GetPortalWifiStatus] verificación/re-push del guest falló (best-effort):', err);
      }
    }

    return { action: 'deleting', since: intent.since, status: 'in_progress' };
  }

  /** ¿La lectura VIVA muestra MACs online en el índice WLAN del puerto guest del intent? */
  private async guestWlanHasOnlineMacs(sn: string, intent: WifiGuestIntent): Promise<boolean> {
    const wlanIndex = wifiPortWlanIndex(intent.port);
    if (wlanIndex === null) return false;
    const macs = await this.wifi.getOnlineWifiMacs(sn);
    return macs.some((m) => m.wlanIndex === wlanIndex);
  }
}
