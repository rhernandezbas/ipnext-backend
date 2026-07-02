/**
 * PppoeNasMoveEventRepository — domain port del registro VISIBLE de movimientos de NAS
 * (pppoe-move-nas, REQ-LOG-1 / design D6 punto 2).
 *
 * TODO intento de move (manual o auto, con o sin contrato) persiste una fila con su outcome:
 * los fallos del auto-move (pool lleno) y los skips (IP pública) NO pueden vivir solo en el
 * stdout del container — se listan en el tab "Movimientos NAS" de la auditoría de Gestión de Red.
 *
 * Append-only: record() inserta, sin updates ni deletes (misma filosofía que
 * ContractServiceEventRepository). Vive en domain: cero imports de infrastructure/Prisma.
 */

export type PppoeNasMoveTrigger = 'manual' | 'auto';

/**
 * fix wave 1 (ajuste 5): +`failed_db` (update de DB falló DESPUÉS del changeFramedIp OK —
 * divergencia RADIUS↔DB con rastro) y +`failed_router` (fallo del move legacy por API router).
 *
 * D-W2.5 (items 4/5): +`skipped_stale_session` (freshness gate C1 — la sesión ganadora no tiene
 * actividad reciente, una colgada vieja jamás dispara un move) y +`skipped_nas_conflict` (W7 —
 * sesiones vivas en NAS distintos entre sí, estado terminal del C1 VISIBLE en el tab, ya no un
 * WARN de stdout). Ambos degradan graceful en el FE actual (OutcomeBadge renderiza texto plano
 * para outcomes desconocidos).
 */
export type PppoeNasMoveOutcome =
  | 'moved'
  | 'failed_no_free_ip'
  | 'failed_orchestrator'
  | 'failed_db'
  | 'failed_router'
  | 'skipped_public'
  | 'skipped_unknown_nas'
  | 'skipped_stale_session'
  | 'skipped_nas_conflict';

export interface RecordPppoeNasMoveEventInput {
  username: string;
  pppoeServiceId?: string | null;
  fromNasId?: string | null;
  toNasId?: string | null;
  fromIp?: string | null;
  toIp?: string | null;
  trigger: PppoeNasMoveTrigger;
  outcome: PppoeNasMoveOutcome;
  /** Detalle del fallo/skip (p.ej. code del error del allocator). */
  reason?: string | null;
  /** Operador para trigger 'manual'; 'sistema' para el auto-move (W2). */
  actorName?: string | null;
}

export interface PppoeNasMoveEvent {
  id: string;
  username: string;
  pppoeServiceId: string | null;
  fromNasId: string | null;
  toNasId: string | null;
  fromIp: string | null;
  toIp: string | null;
  trigger: PppoeNasMoveTrigger;
  outcome: PppoeNasMoveOutcome;
  reason: string | null;
  actorName: string | null;
  createdAt: string; // ISO string
}

/**
 * Filtros + paginación del listado (GET /api/pppoe/nas-move-events).
 * `username` es coincidencia PARCIAL case-insensitive (hábito del repo para búsquedas);
 * `outcome`/`trigger` son match exacto. El caller (use case) ya clampeó page/limit.
 *
 * `usernameExact` (D-W2.5 item 7, ADITIVO): igualdad EXACTA case-sensitive del username —
 * lo usan el throttle anti-spam y el cooldown anti-revert del watcher, donde el contains de
 * `username` era un bug ('perez1' matcheaba la fila de 'perez10' y rompía la supresión).
 * Si vienen ambos, `usernameExact` gana.
 */
export interface ListPppoeNasMoveEventsParams {
  page: number;
  limit: number;
  outcome?: string;
  trigger?: string;
  username?: string;
  usernameExact?: string;
}

export interface PppoeNasMoveEventRepository {
  /** Append de un intento de move. Los callers lo envuelven best-effort (el log no tumba el move). */
  record(input: RecordPppoeNasMoveEventInput): Promise<PppoeNasMoveEvent>;
  /**
   * Lista paginada newest-first (createdAt DESC, id DESC como desempate).
   * `total` = count con el MISMO where (sin skip/take), para el paginador del FE.
   */
  list(params: ListPppoeNasMoveEventsParams): Promise<{ items: PppoeNasMoveEvent[]; total: number }>;
}
