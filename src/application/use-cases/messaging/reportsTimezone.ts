/**
 * conversation-events (Ola 2, reports) — helper de zona horaria para el agrupado de los
 * reports (heatmap de tráfico por día×hora, resoluciones por día).
 *
 * DECISIÓN DE TIMEZONE (documentada): los timestamps se guardan en UTC. El AGRUPADO por
 * hora/día se hace en hora LOCAL de Argentina (America/Argentina/Buenos_Aires) para que el
 * heatmap y el "resueltas por día" tengan sentido para el operador (un mensaje de las 23:30
 * ART cae el día correcto, no "mañana UTC"). Argentina NO observa DST desde 2009 → offset
 * FIJO UTC-3 todo el año, así que un simple corrimiento de -3h es EXACTO y equivale al
 * `AT TIME ZONE 'America/Argentina/Buenos_Aires'` que usan los adapters Prisma en SQL.
 * Este helper es la ÚNICA fuente de verdad del offset para los adapters in-memory (y el que
 * garantiza que in-memory y Prisma NO puedan divergir en el bucketing).
 *
 * El FILTRO por rango (`[from,to)`) opera sobre el instante UTC crudo — sólo el BUCKETING
 * (dow/hour/date) se hace en zona AR.
 */

/** Offset fijo de Argentina respecto de UTC (horas). Sin DST desde 2009. */
export const ARGENTINA_UTC_OFFSET_HOURS = -3;

const MS_PER_HOUR = 60 * 60 * 1000;

/** Corre el instante UTC a la hora de pared local de Argentina (UTC-3). */
function toArgentinaWallClock(iso: string): Date {
  const utcMs = new Date(iso).getTime();
  return new Date(utcMs + ARGENTINA_UTC_OFFSET_HOURS * MS_PER_HOUR);
}

/**
 * Día-de-semana (0=domingo … 6=sábado) y hora (0…23) en zona AR para un instante ISO.
 * Se leen con `getUTC*` DESPUÉS del corrimiento (el shift ya incorporó el offset — usar
 * getUTC* evita que la timezone del proceso Node contamine el resultado).
 */
export function toArgentinaDowHour(iso: string): { dow: number; hour: number } {
  const shifted = toArgentinaWallClock(iso);
  return { dow: shifted.getUTCDay(), hour: shifted.getUTCHours() };
}

/** Fecha local de Argentina como `YYYY-MM-DD` para un instante ISO. */
export function toArgentinaDateKey(iso: string): string {
  const shifted = toArgentinaWallClock(iso);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
