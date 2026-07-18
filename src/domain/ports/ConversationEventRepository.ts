/**
 * conversation-events (Ola 2) — historial APPEND-ONLY de transiciones de una conversación
 * del inbox (design: cimiento de los reports de Ola 3). El registro es BEST-EFFORT desde
 * los write-paths (un fallo al registrar el evento NUNCA debe tumbar la operación de
 * negocio — misma disciplina que el sync de `lastPublicMessageDirection`): el que llama
 * envuelve `record` en su propio try/catch. Las queries de agregación viven acá (anti-N+1:
 * un GROUP BY en el adapter, jamás scans por celda).
 *
 * Fechas: ISO-8601 strings en la frontera del port (misma convención que
 * `ConversationRecord`/`ChatMessageRecord`), nunca `Date` crudos de Prisma.
 */

export type ConversationEventType =
  | 'created'
  | 'resolved'
  | 'reopened'
  | 'assigned'
  | 'unassigned'
  | 'area_changed'
  // conversation-snooze (Ola 6c) — 'snoozed': el agente pospuso la conversación (SnoozeConversation).
  // 'unsnoozed': reactivación automática al vencer el snoozedUntil (ReactivateExpiredSnoozes / watcher).
  | 'snoozed'
  | 'unsnoozed';

export interface RecordConversationEventInput {
  conversationId: string;
  type: ConversationEventType;
  /** Usuario RBAC que disparó la transición, o `null`/ausente si vino del webhook/sistema. */
  actorId?: string | null;
  /** Valor viejo de la transición (ej. assignee/área/status previo). `null` = sin valor previo. */
  fromValue?: string | null;
  /** Valor nuevo de la transición. `null` = quitado (ej. desasignar / limpiar área). */
  toValue?: string | null;
}

export interface ConversationEventRecord {
  id: string;
  conversationId: string;
  type: ConversationEventType;
  actorId: string | null;
  fromValue: string | null;
  toValue: string | null;
  createdAt: string;
}

/**
 * conversation-events (Ola 2, reports) — resoluciones por día calendario. `date` es la
 * fecha LOCAL de Argentina (`YYYY-MM-DD`, America/Argentina/Buenos_Aires, UTC-3 fijo — sin
 * DST desde 2009) del `createdAt` del evento 'resolved'. Sólo se devuelven días con
 * `count > 0` (celdas vacías se omiten — el FE rellena con 0).
 */
export interface ResolutionsByDay {
  date: string;
  count: number;
}

export interface ConversationEventRepository {
  /**
   * Registra una transición (append-only). Devuelve el record creado. El fallo se propaga
   * como excepción: es responsabilidad del CALLER envolverlo en try/catch para el
   * best-effort (un evento perdido no debe tumbar el resolve/assign/creación).
   */
  record(input: RecordConversationEventInput): Promise<ConversationEventRecord>;
  /**
   * reports/overview — cuenta eventos de un `type` cuyo `createdAt` cae en el rango
   * SEMI-ABIERTO `[fromIso, toIso)`. Anti-N+1: un solo `COUNT` sobre el índice
   * `(type, createdAt)`. Usado para `resolvedInRange`.
   */
  countByTypeBetween(type: ConversationEventType, fromIso: string, toIso: string): Promise<number>;
  /**
   * reports/resolutions — eventos 'resolved' en `[fromIso, toIso)` agrupados por día LOCAL
   * de Argentina (UTC-3). Anti-N+1: un solo GROUP BY. Orden ascendente por fecha.
   */
  resolvedCountByDay(fromIso: string, toIso: string): Promise<ResolutionsByDay[]>;
  /**
   * Timeline completo de una conversación (ASC por createdAt). Cimiento del historial que
   * consumirá Ola 3; también lo usan los tests para verificar los eventos registrados.
   */
  listByConversation(conversationId: string): Promise<ConversationEventRecord[]>;
}
