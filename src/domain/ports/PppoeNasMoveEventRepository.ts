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

export type PppoeNasMoveOutcome =
  | 'moved'
  | 'failed_no_free_ip'
  | 'failed_orchestrator'
  | 'skipped_public'
  | 'skipped_unknown_nas';

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
 */
export interface ListPppoeNasMoveEventsParams {
  page: number;
  limit: number;
  outcome?: string;
  trigger?: string;
  username?: string;
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
