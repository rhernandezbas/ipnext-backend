import { ARGENTINA_UTC_OFFSET_HOURS, toArgentinaDateKey } from '@application/use-cases/messaging/reportsTimezone';

/**
 * portal-usage-metrics — el PERÍODO de "Mi consumo": el MES CALENDARIO en curso
 * (decisión del usuario), no 30 días móviles.
 *
 * El mes se recorta en hora LOCAL de Argentina, no en UTC: a las 21:30 del 31 de
 * julio en Argentina ya es 1 de agosto en UTC, y un corte por UTC le cambiaría
 * el mes al cliente tres horas antes de tiempo.
 *
 * El offset sale de `reportsTimezone.ts` a propósito — ese módulo se declara la
 * ÚNICA fuente de verdad del UTC-3 para todo lo que agrupa por día, y es el
 * mismo que los adapters Prisma expresan como
 * `AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires'` en SQL.
 * Copiar el `-3` acá sería exactamente la clase de duplicación que después
 * driftea. (Argentina no observa DST desde 2009 → el offset es FIJO.)
 */
export interface PortalUsagePeriod {
  /** `YYYY-MM-01` — día 1 del mes en curso (AR). */
  from: string;
  /** `YYYY-MM-DD` — hoy (AR). */
  to: string;
  /**
   * Instante UTC del arranque del período: el 1 a las 00:00 ART = 03:00Z. Es el
   * `from` (inclusive) que se le pasa al `UsageMetricsReader`.
   */
  fromUtc: Date;
  /** Todos los días del 1 a hoy INCLUSIVE, `YYYY-MM-DD`, en orden. */
  days: string[];
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function currentArgentinaMonthPeriod(now: Date): PortalUsagePeriod {
  const todayKey = toArgentinaDateKey(now.toISOString()); // p.ej. '2026-08-05'
  const [year, month, day] = todayKey.split('-').map(Number) as [number, number, number];

  const days: string[] = [];
  for (let d = 1; d <= day; d++) {
    days.push(`${year}-${pad(month)}-${pad(d)}`);
  }

  return {
    from: `${year}-${pad(month)}-01`,
    to: todayKey,
    // `Date.UTC(y, m-1, 1, 3)`: la medianoche ART del día 1 expresada en UTC.
    fromUtc: new Date(Date.UTC(year, month - 1, 1, -ARGENTINA_UTC_OFFSET_HOURS, 0, 0, 0)),
    days,
  };
}
