/**
 * wifi-guest-pending — intent PERSISTIDO de un cambio de la red de visitas
 * (alta o baja) en vuelo.
 *
 * Por qué existe: en el Huawei EG8041V5 `shutdown_wifi_port` es aceptado por
 * SmartOLT (su DB queda Disabled) pero el push TR-069 al equipo SE PIERDE — el
 * SSID sigue emitiendo con clientes conectados (verificado EN VIVO 2026-08-05,
 * sn HWTCA92F96B1: details=Disabled mientras full_status muestra WLAN 2 con
 * MACs online). El BE devolvía `{applied:true}` fire-and-forget creyéndole a
 * la DB mentirosa. El intent registra el cambio para que el GET del portal lo
 * evalúe lazy (sin cron): verificar contra la lectura VIVA
 * (`getOnlineWifiMacs`), re-pushear UNA vez y degradar a 'unconfirmed' si a
 * los 10 min la radio sigue al aire.
 *
 * Persistido en DB (tabla `WifiGuestIntent`) — sobrevive restarts del BE:
 * un deploy en medio de la ventana de 10 min no puede perder la verificación.
 * UNIQUE por sn: UN intent por ONU a la vez (el contrato del portal expone un
 * solo `guestPending`, sin banda).
 */
export type WifiGuestIntentAction = 'creating' | 'deleting';

export interface WifiGuestIntent {
  id: string;
  /** Serial NORMALIZADO (normalizeOnuSerial) — misma clave que el resto de wifi-self-service. */
  sn: string;
  action: WifiGuestIntentAction;
  /** Puerto de visita afectado ('wifi_0/2' | 'wifi_0/6') — para el re-push y el índice WLAN de verificación. */
  port: string;
  /** ISO 8601 — inicio del cambio. Lo pone el use case (reloj inyectable), no la DB. */
  since: string;
  /** ISO 8601 — sellado tras el ÚNICO re-push del flujo deleting. null = nunca re-pusheado. */
  retriedAt: string | null;
}

export interface ReplaceWifiGuestIntentInput {
  sn: string;
  action: WifiGuestIntentAction;
  port: string;
  since: string;
}

export interface WifiGuestIntentRepository {
  /** El intent activo de la sn, o null. */
  findBySn(sn: string): Promise<WifiGuestIntent | null>;
  /**
   * Upsert por sn (unique): crea el intent o PISA el anterior (reintento sobre
   * un 'unconfirmed'). `retriedAt` SIEMPRE vuelve a null — el intent nuevo
   * tiene su propio presupuesto de re-push.
   */
  replace(input: ReplaceWifiGuestIntentInput): Promise<WifiGuestIntent>;
  /** Sella el único re-push del flujo deleting. */
  markRetried(id: string, retriedAtIso: string): Promise<void>;
  /** Cierra el intent (aplicado confirmado o pending del alta expirado). Idempotente. */
  deleteBySn(sn: string): Promise<void>;
}
