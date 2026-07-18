/**
 * note-mentions (Ola 6b) — registro de @menciones en notas internas + vista "Menciones".
 *
 * Cuando un agente escribe una nota interna con el token `@[nombre](userId)` (ver
 * `parseMentions`), se registra UNA fila `ConversationMention` por usuario mencionado. La
 * vista "Menciones" del inbox lista las conversaciones donde el usuario ACTUAL tiene al menos
 * una mención NO leída (`readAt IS NULL`).
 *
 * El registro es BEST-EFFORT desde `SendMessage` (misma disciplina que `ConversationEvent` y
 * el sync de `lastPublicMessageDirection`): un fallo al registrar menciones NUNCA debe tumbar
 * la creación de la nota — el caller envuelve `record` en su propio try/catch.
 *
 * Fechas: ISO-8601 strings en la frontera del port (misma convención que
 * `ConversationRecord`/`ChatMessageRecord`/`ConversationEventRecord`), nunca `Date` de Prisma.
 */

export interface RecordConversationMentionInput {
  conversationId: string;
  /** ChatMessage (la nota interna) donde ocurrió la mención — clave del UNIQUE(message,user). */
  messageId: string;
  /** RbacUser mencionado (el que verá la conversación en su vista "Menciones"). */
  mentionedUserId: string;
  /** RbacUser autor de la nota (`req.user.id`), o `null` si no se conoce. */
  mentionedByUserId?: string | null;
}

export interface ConversationMentionRecord {
  id: string;
  conversationId: string;
  messageId: string;
  mentionedUserId: string;
  mentionedByUserId: string | null;
  createdAt: string;
  /** `null` = no leída (aparece en la vista "Menciones"); ISO = ya vista. */
  readAt: string | null;
}

export interface ConversationMentionRepository {
  /**
   * Registra una mención. IDEMPOTENTE por `(messageId, mentionedUserId)` — re-registrar la
   * misma mención (p.ej. re-proceso, o el mismo usuario nombrado dos veces en la nota) NUNCA
   * duplica la fila. El fallo se propaga como excepción: es responsabilidad del CALLER
   * envolverlo en try/catch para el best-effort (una mención perdida no tumba la nota).
   */
  record(input: RecordConversationMentionInput): Promise<ConversationMentionRecord>;
  /**
   * Marca como leídas (`readAt = readAtIso`) TODAS las menciones NO leídas del usuario
   * `userId` en la conversación `conversationId`. Devuelve cuántas filas marcó (0 si no
   * había pendientes). Idempotente: llamarla dos veces no re-marca lo ya leído.
   */
  markReadForUser(conversationId: string, userId: string, readAtIso: string): Promise<number>;
  /**
   * Timeline de menciones de una conversación (ASC por createdAt). Lo usan los tests para
   * verificar lo registrado; base de cualquier lectura futura del hilo de menciones.
   */
  listByConversation(conversationId: string): Promise<ConversationMentionRecord[]>;
}
