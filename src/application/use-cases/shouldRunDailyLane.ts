/**
 * Decisión PURA de si corresponde correr el carril LENTO de refresco de balances
 * (`SLOW_LANE`, las Bajas) en este tick.
 *
 * Vive separada del scheduler a propósito (spec LANE-2.2): la regla "una vez por
 * día, de madrugada argentina" se puede testear sin timers ni relojes falsos.
 *
 * Por qué NO un `setInterval` de 24 h: eso ancla la corrida al momento del
 * deploy. Deployás a las 14:00 y el carril lento —70 min de llamadas a GR— corre
 * todos los días a las 14:00, en pleno horario de trabajo. Con esta función el
 * ticker sigue siendo horario y la corrida cae siempre de madrugada.
 */

/** Inicio de la ventana (hora de Argentina, inclusive). */
export const DAILY_LANE_WINDOW_START_HOUR_AR = 3;
/**
 * Fin de la ventana (hora de Argentina, EXCLUSIVE).
 *
 * La ventana abarca varias horas a propósito: los dos carriles comparten un
 * guard de exclusión, así que si el carril rápido está en vuelo a las 3:00 el
 * lento pierde ese tick. Con una ventana de una sola hora se saltearía el día
 * entero, en silencio. Con 3 horas tiene tres intentos.
 */
export const DAILY_LANE_WINDOW_END_HOUR_AR = 6;

const AR_TIME_ZONE = 'America/Argentina/Buenos_Aires';

/**
 * Partes de fecha/hora de un instante, en hora de ARGENTINA.
 *
 * El contenedor de prod corre en **UTC** (ver el gotcha del password diario de
 * GR en WORKFLOW-MULTI-REPO). Derivar la hora con `getHours()` haría que "las 3
 * de la madrugada" cayera en realidad a la medianoche argentina, y comparar el
 * "mismo día" en UTC partiría el día argentino a las 21:00. Se usa `Intl`, que
 * corre sobre el ICU embebido de node y funciona en `node:alpine` sin el
 * `tzdata` del OS — mismo patrón que `arCalendarDate` en `mapGrInvoice.ts`.
 */
function arParts(d: Date): { calendarDate: string; hour: number } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: AR_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  // `hour12: false` puede rendir "24" para la medianoche en algunos ICU — se
  // normaliza a 0 para que la comparación de ventana no se rompa en ese borde.
  const hour = Number(get('hour')) % 24;
  return {
    calendarDate: `${get('year')}-${get('month')}-${get('day')}`,
    hour,
  };
}

/**
 * `true` si el carril lento debe correr AHORA: la hora argentina está dentro de
 * la ventana de madrugada y todavía no corrió en este día calendario argentino.
 *
 * @param lastRunAt última corrida registrada en `SyncState`, o `null` si nunca corrió.
 * @param now instante actual.
 */
export function shouldRunDailyLane(lastRunAt: Date | null | undefined, now: Date): boolean {
  const nowAr = arParts(now);

  const inWindow =
    nowAr.hour >= DAILY_LANE_WINDOW_START_HOUR_AR && nowAr.hour < DAILY_LANE_WINDOW_END_HOUR_AR;
  if (!inWindow) return false;

  if (!lastRunAt) return true;

  // Comparación por día calendario ARGENTINO (string YYYY-MM-DD), inmune a la
  // timezone del proceso.
  return arParts(lastRunAt).calendarDate !== nowAr.calendarDate;
}
