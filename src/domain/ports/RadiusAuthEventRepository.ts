import { RadiusAuthEvent, RadiusAuthReply } from '@domain/entities/radius-auth-event';

/**
 * Filtros base sin paginación ni reason.
 * Usados por `countByReason` para el desglose COMPLETO ignorando el reason seleccionado.
 */
export interface RadiusAuthBaseFilters {
  username?: string;
  /** 'Access-Accept' | 'Access-Reject' */
  reply?: RadiusAuthReply;
  from?: Date;      // authdate >= from
  to?: Date;        // authdate <= to
}

export interface RadiusAuthEventFilters extends RadiusAuthBaseFilters {
  /** Motivo de rechazo: 'session_stuck' | 'user_not_found' | 'other'. Filtra sólo la lista `data`. */
  reason?: string;
  page: number;
  pageSize: number;
}

export interface RadiusAuthEventUpsert {
  sourceUniqueId: string;
  username: string;
  reply: RadiusAuthReply;
  authdate: Date;
  class: string | null;
  /** Motivo del rechazo. Se persiste UNA VEZ en el create; el update NO lo pisa (congelado). */
  reason: string | null;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface RadiusAuthEventRepository {
  /**
   * Ingest path — upsert idempotente por `sourceUniqueId`.
   * Primera vez → insert. Re-ingest del mismo evento → no duplica.
   * Devuelve la cantidad de filas procesadas.
   */
  upsertMany(rows: RadiusAuthEventUpsert[]): Promise<number>;

  /**
   * Query path — filtra y pagina eventos de auth (orden authdate DESC).
   * Acepta `filters.reason` opcional para filtrar sólo la lista paginada.
   */
  list(filters: RadiusAuthEventFilters): Promise<PaginatedResult<RadiusAuthEvent>>;

  /**
   * Conteo por motivo de rechazo, ignorando el filtro `reason`.
   * Aplica username / reply / from / to pero NO reason → el FE obtiene el desglose
   * COMPLETO independientemente del motivo seleccionado.
   * Solo cuenta filas con reason NOT NULL (eventos de rechazo con motivo).
   * Devuelve un map reason → count (claves presentes sólo si count > 0).
   */
  countByReason(filters: RadiusAuthBaseFilters): Promise<Record<string, number>>;

  /**
   * Purge step: borra eventos con authdate < cutoff en lotes de batchSize.
   * Devuelve la cantidad total de filas borradas.
   */
  deleteOlderThan(cutoff: Date, batchSize: number): Promise<number>;
}
