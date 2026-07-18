/**
 * conversation-events (Ola 2, reports) — DTOs de los endpoints de agregación que consume
 * el dashboard de Ola 3. Nunca exponen records/entidades crudas.
 *
 * TIMEZONE: los timestamps son UTC. Los "current" son point-in-time (ahora). Los "inRange"
 * cuentan sobre el rango SEMI-ABIERTO `[from, to)` (el FE manda los bordes como instantes
 * UTC). El BUCKETING por día/hora (traffic, resolutions) se hace en zona AR
 * (America/Argentina/Buenos_Aires, UTC-3 fijo) — ver `MESSAGING_REPORTS_TIMEZONE`.
 */

export const MESSAGING_REPORTS_TIMEZONE = 'America/Argentina/Buenos_Aires';

/**
 * GET /api/messaging/reports/overview — tiles del dashboard.
 * - `*InRange`: actividad en `[from, to)`. `resolvedInRange` = eventos 'resolved' (throughput,
 *   coincide con la suma de `resolutions.days`; forward-looking — las resoluciones previas al
 *   deploy no tienen evento). `createdInRange` = conversaciones con `createdAt` en el rango
 *   (fuente COMPLETA: la columna, no eventos).
 * - `current*`: estado ACTUAL. `currentOpen`/`currentUnattended`/`currentUnassigned` reusan
 *   `GetInboxViewCounts` (all/unattended/unassigned). `currentPending` = status exacto 'pending'.
 */
export interface ReportsOverviewDto {
  resolvedInRange: number;
  createdInRange: number;
  currentOpen: number;
  currentUnattended: number;
  currentUnassigned: number;
  currentPending: number;
}

/** Celda del heatmap de tráfico entrante (día-de-semana × hora, zona AR). Sólo count>0. */
export interface TrafficCellDto {
  /** 0 (domingo) … 6 (sábado), en zona AR. */
  dow: number;
  /** 0 … 23, en zona AR. */
  hour: number;
  count: number;
}

/** GET /api/messaging/reports/traffic — heatmap de mensajes INBOUND por día×hora (zona AR). */
export interface TrafficReportDto {
  /** Zona del agrupado (documenta que dow/hour son locales de AR, no UTC). */
  timezone: string;
  cells: TrafficCellDto[];
}

/** Resoluciones de un día calendario (zona AR). */
export interface ResolutionsDayDto {
  date: string; // 'YYYY-MM-DD' (zona AR)
  count: number;
}

/** GET /api/messaging/reports/resolutions — eventos 'resolved' por día (zona AR). */
export interface ResolutionsReportDto {
  timezone: string;
  days: ResolutionsDayDto[];
}
