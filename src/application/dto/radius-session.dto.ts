/**
 * DTOs de sesiones RADIUS activas (gestion-red-sessions + network-sessions-pools-redesign).
 *
 * Reglas:
 * - RadiusSessionDto mapea 1:1 la entidad RadiusSession — NO se devuelve la entidad cruda.
 * - PaginatedRadiusSessionsDto solo se produce cuando la request trae al menos un param.
 *   Sin params → el use case devuelve RadiusSession[] (back-compat).
 */

// ── RadiusSessionDto ────────────────────────────────────────────────────────────

export interface RadiusSessionDto {
  id: string;
  sessionId: string;
  username: string;
  clientName: string;
  nasId: string | null;         // = nasIp en la fuente real
  nasName: string | null;       // = nasIp en la fuente real
  ipAddress: string | null;     // framedIp
  macAddress: string | null;    // callerId
  startedAt: string;            // ISO 8601
  duration: number;             // segundos
  downloadBytes: number;
  uploadBytes: number;
  downloadMbps: number;         // 0 en la fuente real (el orchestrator no expone tasa instantánea)
  uploadMbps: number;           // 0 en la fuente real
  status: 'active' | 'idle';   // 'active' siempre en la fuente real
  contractId: string | null;
  clientId: string | null;
  customerName: string | null;
}

// ── KPIs de estado ──────────────────────────────────────────────────────────────

/**
 * Stats calculadas sobre el set filtrado por search+nasId, IGNORANDO el filtro status.
 * Así el FE puede mostrar el desglose completo aunque el usuario haya seleccionado un estado.
 * Patrón idéntico a countsByReason de ListRadiusAuthFailures.
 *
 * - total: filas que matchean search+nasId (sin filtrar por status) → es el BADGE del tab.
 * - active + idle = total.
 */
export interface RadiusSessionsStats {
  total: number;
  active: number;
  idle: number;
}

// ── Envelope paginado ───────────────────────────────────────────────────────────

/**
 * Producido por ListRadiusSessions.execute(params) cuando params tiene al menos un campo.
 *
 * - total: filas que matchean TODOS los filtros (incl. status) → gobierna hasNext y totalPages.
 * - stats.total: filas que matchean search+nasId ignorando status → badge del tab.
 * - hasNext: page * limit < total.
 */
export interface PaginatedRadiusSessionsDto {
  data: RadiusSessionDto[];
  total: number;
  page: number;
  limit: number;
  hasNext: boolean;
  stats: RadiusSessionsStats;
}
