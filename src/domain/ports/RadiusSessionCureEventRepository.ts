/**
 * RadiusSessionCureEventRepository — domain port del registro VISIBLE de intentos de curación
 * de sesiones RADIUS colgadas (radius-session-autocure BE-1, REQ-CURE-5).
 *
 * Molde 1:1 de PppoeNasMoveEventRepository: append-only, soft refs sin FK (el log sobrevive al
 * borrado de NAS/servicio), outcome String libre (outcomes nuevos sin migración). Vive en
 * domain: cero imports de infrastructure/Prisma.
 */

export type RadiusSessionCureTrigger = 'auto' | 'manual';
/** Qué evidencia justificó la cura — null en skips/failed (no hubo cura). */
export type RadiusSessionCureSignal = 'persistent_rejects' | 'stale_interim';
/** Qué se ejecutó efectivamente. null si no se ejecutó nada (skip previo a cualquier acción). */
export type RadiusSessionCureAction = 'both' | 'acct_close' | 'coa';
export type RadiusSessionCureOutcome =
  | 'cured'
  | 'already_cured'
  | 'skipped_alive'
  | 'skipped_ambiguous'
  | 'skipped_no_session'
  | 'skipped_no_signal'
  | 'flagged_flapping'
  | 'failed';

export interface RecordRadiusSessionCureEventInput {
  username: string;
  nasIp?: string | null;
  sessionId?: string | null;
  /** ISO 8601. */
  sessionStartedAt?: string | null;
  /** ISO 8601 — el interim al momento de evaluar (null si no había señal). */
  sessionLastUpdate?: string | null;
  signalUsed?: RadiusSessionCureSignal | null;
  trigger: RadiusSessionCureTrigger;
  action?: RadiusSessionCureAction | null;
  outcome: RadiusSessionCureOutcome;
  reason?: string | null;
  /** 'sistema' (auto) | nombre del operador (manual). */
  actorName?: string | null;
}

export interface RadiusSessionCureEvent {
  id: string;
  username: string;
  nasIp: string | null;
  sessionId: string | null;
  sessionStartedAt: string | null;
  sessionLastUpdate: string | null;
  signalUsed: RadiusSessionCureSignal | null;
  trigger: RadiusSessionCureTrigger;
  action: RadiusSessionCureAction | null;
  outcome: RadiusSessionCureOutcome;
  reason: string | null;
  actorName: string | null;
  createdAt: string; // ISO string
}

/**
 * Filtros + paginación del listado (GET /api/radius/session-cures) y de los checks internos
 * del watcher (cure-throttle 30min, flapping ≥3/24h, throttle de registro 6h) — todos reusan
 * `list()` con `usernameExact` + `outcome` + `from` sobre los índices existentes.
 *
 * `usernameExact` (igualdad EXACTA) evita el bug de `pppoeNasMoveThrottle` (contains matcheando
 * 'perez1' con 'perez10'). Si vienen ambos, `usernameExact` gana.
 */
export interface ListRadiusSessionCureEventsParams {
  page: number;
  limit: number;
  outcome?: string;
  trigger?: string;
  /** Coincidencia PARCIAL case-insensitive (búsquedas del FE). */
  username?: string;
  /** Igualdad EXACTA case-sensitive (throttle/flapping del watcher). */
  usernameExact?: string;
  from?: Date; // createdAt >= from
  to?: Date;   // createdAt <= to
}

export interface RadiusSessionCureEventRepository {
  /** Append de un intento de cura. Los callers lo envuelven best-effort cuando corresponde. */
  record(input: RecordRadiusSessionCureEventInput): Promise<RadiusSessionCureEvent>;
  /**
   * Lista paginada newest-first (createdAt DESC, id DESC como desempate).
   * `total` = count con el MISMO where (sin skip/take), para el paginador del FE.
   */
  list(params: ListRadiusSessionCureEventsParams): Promise<{ items: RadiusSessionCureEvent[]; total: number }>;
  /**
   * Conteo por outcome, ignorando el filtro `outcome` (desglose completo para los chips del FE).
   * Espejo de `RadiusAuthEventRepository.countByReason`.
   */
  countByOutcome(filters: { username?: string; trigger?: string; from?: Date; to?: Date }): Promise<Record<string, number>>;
}
