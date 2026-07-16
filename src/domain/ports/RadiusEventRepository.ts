import { RadiusEvent } from '@domain/entities/radius-event';

export interface RadiusEventFilters {
  username?: string;
  nasId?: string;
  vlanId?: number;
  /** 'online' (stoppedAt IS NULL) | 'closed' (stoppedAt IS NOT NULL) */
  status?: 'online' | 'closed';
  /** Filtro por tipo de evento RADIUS: 'start' | 'stop' | 'interim' */
  eventType?: 'start' | 'stop' | 'interim';
  from?: Date;      // startedAt >= from
  to?: Date;        // startedAt <= to
  page: number;
  pageSize: number;
}

export interface RadiusEventUpsert {
  sourceUniqueId: string;
  username: string;
  nasIpAddress: string;
  nasId: string | null;
  framedIp: string | null;
  macAddress: string | null;
  vlanId: number | null;
  startedAt: Date;
  stoppedAt: Date | null;
  sessionTime: number | null;
  bytesIn: bigint;
  bytesOut: bigint;
  eventType: 'start' | 'stop' | 'interim';
  status: 'online' | 'closed';
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Resumen de última conexión para un username, calculado en una sola query agregada.
 * Permite distinguir entre el evento más reciente (cualquier tipo) y el último CERRADO.
 */
export interface LastConnectionSummary {
  /** startedAt del evento más reciente (el que tiene el startedAt mayor, independiente del tipo) */
  lastStartedAt: string;        // ISO 8601
  /** stoppedAt del último evento CERRADO (stoppedAt IS NOT NULL). Null si nunca cerró. */
  lastStoppedAt: string | null; // ISO 8601
  /** true si existe algún evento con stoppedAt IS NULL para este username */
  currentlyOnline: boolean;
  /** framedIp del evento más reciente */
  lastFramedIp: string | null;
  /** vlanId del evento más reciente */
  lastVlanId: number | null;
}

export interface RadiusEventRepository {
  /**
   * Ingest path — upsert idempotente por `sourceUniqueId`.
   * Primera vez → insert. Siguiente vez (p.ej. session que cerró) → update.
   * Devuelve la cantidad de filas procesadas.
   */
  upsertMany(rows: RadiusEventUpsert[]): Promise<number>;

  /**
   * Query path — filtra y pagina eventos.
   */
  list(filters: RadiusEventFilters): Promise<PaginatedResult<RadiusEvent>>;

  /**
   * Powers la Auditoría NE8000: resumen de última conexión por username (dentro de un nasId).
   * UNA sola query para todos los usernames del lote (sin N+1, AD-4).
   * Devuelve Map username → LastConnectionSummary (ausente si no hay eventos para ese username).
   */
  lastEventByUsername(nasId: string, usernames: string[]): Promise<Map<string, LastConnectionSummary>>;

  /**
   * Purge step: borra eventos con startedAt < cutoff en lotes de batchSize.
   * Devuelve la cantidad total de filas borradas.
   */
  deleteOlderThan(cutoff: Date, batchSize: number): Promise<number>;

  /**
   * contract-node-ap-auto-assign (CAS-1) — batch: para cada username, la macAddress del
   * "mejor" evento — prefiere status='online' (stoppedAt IS NULL); si no hay online, el de
   * startedAt más reciente. Solo considera eventos con macAddress != null. UNA query agregada
   * para todo el lote, jamás N+1. El Map NO incluye entrada para usernames sin ningún evento
   * con mac (ausente, no `undefined`).
   */
  latestMacByUsernames(usernames: string[]): Promise<Map<string, string>>;
}
