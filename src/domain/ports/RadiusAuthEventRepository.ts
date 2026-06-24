import { RadiusAuthEvent, RadiusAuthReply } from '@domain/entities/radius-auth-event';

export interface RadiusAuthEventFilters {
  username?: string;
  /** 'Access-Accept' | 'Access-Reject' */
  reply?: RadiusAuthReply;
  from?: Date;      // authdate >= from
  to?: Date;        // authdate <= to
  page: number;
  pageSize: number;
}

export interface RadiusAuthEventUpsert {
  sourceUniqueId: string;
  username: string;
  reply: RadiusAuthReply;
  authdate: Date;
  class: string | null;
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
   */
  list(filters: RadiusAuthEventFilters): Promise<PaginatedResult<RadiusAuthEvent>>;

  /**
   * Purge step: borra eventos con authdate < cutoff en lotes de batchSize.
   * Devuelve la cantidad total de filas borradas.
   */
  deleteOlderThan(cutoff: Date, batchSize: number): Promise<number>;
}
