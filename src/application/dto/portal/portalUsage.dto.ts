/**
 * portal-usage-metrics — DTO de "Mi consumo" (`GET /api/portal/usage/:contractId`).
 *
 * Contrato PINEADO: la app se construye contra esta forma. El endpoint responde
 * SIEMPRE 200 salvo el 404 anti-IDOR.
 *
 * Los bytes viajan como `number`, no como `bigint`: `JSON.stringify` no sabe
 * serializar BigInt (tira TypeError). El techo real no molesta — el consumo
 * mensual de un cliente ronda 1e12 bytes (1 TB) contra los 9e15 de
 * `Number.MAX_SAFE_INTEGER`, cuatro órdenes de magnitud de margen.
 */

export interface PortalUsageDailyDto {
  /** `YYYY-MM-DD` (hora local de Argentina). */
  date: string;
  downloadBytes: number;
  uploadBytes: number;
}

export interface PortalUsagePeakDayDto {
  date: string;
  totalBytes: number;
}

export interface PortalUsagePeriodDto {
  /** Día 1 del mes en curso, `YYYY-MM-DD`. */
  from: string;
  /** HOY, `YYYY-MM-DD`. El período es el mes calendario EN CURSO, no 30 días móviles. */
  to: string;
}

export interface PortalUsageMetricsDto {
  /**
   * `false` = no hay nada que mostrar: el contrato no tiene un PPPoE resoluble,
   * o no hubo ninguna sesión en el mes. NO es un error — el resto del payload
   * viene en `0`/`[]`/`null` y el `period` viaja igual (la app dibuja el
   * encabezado del mes de todas formas).
   */
  available: boolean;
  period: PortalUsagePeriodDto;
  downloadBytes: number;
  uploadBytes: number;
  totalBytes: number;
  /**
   * Un item POR DÍA del mes hasta hoy, ceros incluidos — así el gráfico de la app
   * no tiene que inventar los huecos. Vacío cuando `available:false`.
   */
  daily: PortalUsageDailyDto[];
  /** Día de mayor consumo total. `null` si no hubo tráfico. */
  peakDay: PortalUsagePeakDayDto | null;
}
