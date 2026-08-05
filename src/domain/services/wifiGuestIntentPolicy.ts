import type { WifiGuestIntent } from '@domain/ports/WifiGuestIntentRepository';

/**
 * wifi-guest-pending — política de edad del intent de cambio de la red de
 * visitas. Función PURA (sin I/O), compartida por los tres use cases del
 * portal: el GET la usa para derivar el status y decidir re-push; el PUT y el
 * disable para el 409 de "cambio en curso".
 *
 * Ventanas (contrato del change, fijo con la app):
 *  - < 10 min  -> el intent está EN CURSO ('in_progress'): nuevos writes -> 409.
 *  - >= 10 min -> dejó de estar en curso: el GET lo resuelve (unconfirmed /
 *    borrar) y los writes PUEDEN reintentar (reemplazan el intent).
 *  - > 3 min (solo deleting, sin retriedAt) -> ventana del ÚNICO re-push.
 *
 * Gotcha "basura al valor seguro": un `since` no parseable da NaN y NaN < X es
 * false -> el intent NO se considera en curso. Es el lado seguro: un intent
 * corrupto jamás puede dejar al cliente bloqueado (409) para siempre.
 */
export const WIFI_GUEST_PENDING_WINDOW_MS = 10 * 60_000;
export const WIFI_GUEST_RETRY_AFTER_MS = 3 * 60_000;

export function wifiGuestIntentAgeMs(intent: Pick<WifiGuestIntent, 'since'>, nowMs: number): number {
  return nowMs - Date.parse(intent.since);
}

/** true = el intent sigue EN CURSO (edad < 10 min): status 'in_progress' y 409 para nuevos writes. */
export function isWifiGuestIntentInProgress(intent: Pick<WifiGuestIntent, 'since'>, nowMs: number): boolean {
  const age = wifiGuestIntentAgeMs(intent, nowMs);
  return age < WIFI_GUEST_PENDING_WINDOW_MS;
}
