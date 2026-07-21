import { randomUUID } from 'crypto';
import {
  ChatMessageRepository,
  ChatMessageRecord,
  UpsertChatMessageInput,
  UpsertBulkChatMessageInput,
  UpsertTemplateChatMessageInput,
  TrafficCell,
} from '@domain/ports/ChatMessageRepository';
import { toArgentinaDowHour } from '@application/use-cases/messaging/reportsTimezone';
import type { InMemoryConversationRepository } from './InMemoryConversationRepository';

/**
 * In-memory ChatMessageRepository for use-case and route tests.
 * Dedup key mirrors the Prisma `@unique` on `chatwootMessageId` (HOOK-4/INBOX-2).
 */
export class InMemoryChatMessageRepository implements ChatMessageRepository {
  private rows: ChatMessageRecord[] = [];
  private conversationRepo: InMemoryConversationRepository | null = null;

  /**
   * inbox-views (Ola 1, VIEW-1) — linkea el repo de conversaciones para mantener
   * el cache desnormalizado `Conversation.lastPublicMessageDirection` tras CADA
   * write de mensaje (espejo del recompute que `PrismaChatMessageRepository` hace
   * contra la MISMA base — acá los "dos repos" son stores separados y necesitan
   * el lazo explícito, mismo idioma live-link que `seedAreas`). Tests que no
   * ejercitan la vista Sin atender pueden no linkear (no-op silencioso).
   */
  linkConversationRepo(repo: InMemoryConversationRepository): void {
    this.conversationRepo = repo;
  }

  /**
   * inbox-views (VIEW-1, fix wave M1) — recompute del último mensaje NO-privado
   * de la conversación por (chatwootCreatedAt DESC, id DESC) — el MISMO orden
   * (invertido) que `listByConversation` usa ASC, y el mismo `DISTINCT ON ...
   * ORDER BY ... DESC` del backfill de la migración. Converge por recompute (no
   * "último write gana"): cada write recalcula desde el store completo. Espejo de
   * la semántica ATÓMICA del statement único de
   * `PrismaChatMessageRepository.syncConversationDirection` — acá es síncrono
   * single-threaded (atómico por construcción) y sin fail-open (no puede fallar);
   * tampoco bumpea `updatedAt` (igual que el $executeRaw, que no pasa por el
   * @updatedAt client-side de Prisma). Degradación conocida: si un mensaje
   * MIGRARA de conversación (no pasa en ningún flujo real), la conversación vieja
   * queda stale hasta su próximo write — mismo tradeoff en el adapter Prisma, no
   * pueden divergir.
   */
  private syncConversationDirection(conversationId: string): void {
    if (!this.conversationRepo) return;
    const latest = this.rows
      .filter((r) => r.conversationId === conversationId && !r.isPrivate)
      .sort((a, b) => {
        const byDate = b.chatwootCreatedAt.localeCompare(a.chatwootCreatedAt);
        if (byDate !== 0) return byDate;
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0; // id DESC tiebreak
      })[0];
    this.conversationRepo.syncLastPublicMessageDirection(conversationId, latest?.direction ?? null);
  }

  /**
   * messaging-inbox-notes (edit/delete, COUNT) — recompute TOTAL del contador de notas
   * internas VIVAS (isPrivate=true AND deletedAt=null) de la conversación, espejo del
   * UPDATE ... COUNT del adapter Prisma. Self-healing (recalcula desde el store completo,
   * no incremental). NUNCA pueden divergir.
   */
  private syncInternalNoteCount(conversationId: string): void {
    if (!this.conversationRepo) return;
    const count = this.rows.filter(
      (r) => r.conversationId === conversationId && r.isPrivate && r.deletedAt === null,
    ).length;
    this.conversationRepo.syncInternalNoteCount(conversationId, count);
  }

  async upsertByChatwootMessageId(input: UpsertChatMessageInput): Promise<ChatMessageRecord> {
    const existing = this.rows.find((r) => r.chatwootMessageId === input.chatwootMessageId);
    if (existing) {
      existing.conversationId = input.conversationId;
      existing.direction = input.direction;
      // messaging-inbox-notes (HIGH) — una nota EDITADA localmente (editedAt != null) es la
      // fuente de verdad LOCAL: Chatwoot no manda ediciones y `GetConversation.syncFromChatwoot`
      // re-espeja el content ORIGINAL en CADA apertura (INBOX-2) → si lo pisáramos, la edición
      // se revertiría permanentemente. Protegemos `content` (y `editedAt`, que ya no se toca)
      // igual que `deletedAt`/`authorId`. Una nota NO editada sí refleja cambios de Chatwoot.
      if (existing.editedAt === null) {
        existing.content = input.content;
      }
      existing.senderName = input.senderName ?? null;
      existing.chatwootCreatedAt = input.chatwootCreatedAt;
      existing.isPrivate = input.isPrivate ?? false;
      // messaging-inbox-notes — authorId es SET-ONCE: el update idempotente del webhook
      // (mismo chatwootMessageId) NO lo pisa (mismo criterio que origin/idempotencyKey).
      // LOW-1 (documentado, edge raro): si un webhook message_created GANA la carrera al
      // upsert local del send (llega antes de que SendMessage persista authorId), la fila
      // queda con authorId null → la nota sólo la edita/borra un supervisor. No se fuerza
      // completar authorId acá para no reintroducir un write en el hot path del webhook.
      this.syncConversationDirection(input.conversationId);
      if (existing.isPrivate) this.syncInternalNoteCount(input.conversationId);
      return { ...existing };
    }

    const row: ChatMessageRecord = {
      id: randomUUID(),
      conversationId: input.conversationId,
      chatwootMessageId: input.chatwootMessageId,
      origin: 'chatwoot',
      campaignRecipientId: null,
      direction: input.direction,
      content: input.content,
      senderName: input.senderName ?? null,
      chatwootCreatedAt: input.chatwootCreatedAt,
      isPrivate: input.isPrivate ?? false,
      createdAt: new Date().toISOString(),
      providerMessageId: null,
      // chatwoot-hub-sendpath (D5) — SET-ONCE: sólo se escribe en el CREATE. La rama
      // UPDATE de arriba NUNCA toca `existing.idempotencyKey` (mismo criterio que authorId).
      idempotencyKey: input.idempotencyKey ?? null,
      // messaging-inbox-notes (edit/delete) — authorId sólo llega con una nota privada
      // (SendMessage lo pasa cuando isPrivate); mensajes públicos quedan null.
      authorId: input.authorId ?? null,
      editedAt: null,
      deletedAt: null,
      // chatwoot-hub-sendpath (D6) — recién creada, sin fallo detectado todavía.
      deliveryStatus: null,
      deliveryError: null,
    };
    this.rows.push(row);
    this.syncConversationDirection(input.conversationId);
    // Sólo una nota privada mueve el contador (crear un mensaje público no lo toca).
    if (row.isPrivate) this.syncInternalNoteCount(input.conversationId);
    return { ...row };
  }

  /**
   * messaging-bulk-inbox (F1, PROYECCIÓN) — idempotente por `campaignRecipientId`.
   * Un mensaje `outbound`/`origin:'bulk'`/`chatwootMessageId:null`. Re-proyectar el
   * mismo recipient actualiza la fila existente, NUNCA duplica.
   */
  async upsertBulkMessage(input: UpsertBulkChatMessageInput): Promise<ChatMessageRecord> {
    const existing = this.rows.find((r) => r.campaignRecipientId === input.campaignRecipientId);
    if (existing) {
      existing.conversationId = input.conversationId;
      existing.content = input.content;
      existing.chatwootCreatedAt = input.chatwootCreatedAt;
      existing.senderName = input.senderName ?? null;
      this.syncConversationDirection(input.conversationId);
      return { ...existing };
    }

    const row: ChatMessageRecord = {
      id: randomUUID(),
      conversationId: input.conversationId,
      chatwootMessageId: null,
      origin: 'bulk',
      campaignRecipientId: input.campaignRecipientId,
      direction: 'outbound',
      content: input.content,
      senderName: input.senderName ?? null,
      chatwootCreatedAt: input.chatwootCreatedAt,
      isPrivate: false,
      createdAt: new Date().toISOString(),
      providerMessageId: null,
      idempotencyKey: null,
      // messaging-inbox-notes — un mensaje bulk NUNCA es una nota interna.
      authorId: null,
      editedAt: null,
      deletedAt: null,
      deliveryStatus: null,
      deliveryError: null,
    };
    this.rows.push(row);
    this.syncConversationDirection(input.conversationId);
    return { ...row };
  }

  /**
   * inbox-template-send (PORT-1) — idempotente por `providerMessageId` (SM sid de
   * Twilio). Un mensaje `outbound`/`origin:'agent_template'`/`chatwootMessageId:null`/
   * `campaignRecipientId:null`. Re-proyectar el MISMO sid actualiza la fila, NUNCA duplica.
   *
   * H1 (fix wave, idempotency-key server-side) — `idempotencyKey` se persiste SOLO
   * en la rama de creación (set-once, mismo criterio que `origin`/`providerMessageId`:
   * un re-upsert por el MISMO `providerMessageId` no la vuelve a tocar). Backstop de
   * carrera: dos sends REALES concurrentes generan `providerMessageId` DISTINTOS (dos
   * SM sid reales de Twilio) pero pueden compartir la MISMA `idempotencyKey` — la
   * segunda `create` acá simula la colisión del `@unique` de Postgres y RECUPERA la
   * fila ganadora en vez de duplicar (cross-ref: misma semántica en
   * `PrismaChatMessageRepository.upsertTemplateMessage`, ambos adapters NO pueden divergir).
   */
  async upsertTemplateMessage(input: UpsertTemplateChatMessageInput): Promise<ChatMessageRecord> {
    const existing = this.rows.find((r) => r.providerMessageId === input.providerMessageId);
    if (existing) {
      existing.conversationId = input.conversationId;
      existing.content = input.content;
      existing.senderName = input.senderName ?? null;
      existing.chatwootCreatedAt = input.chatwootCreatedAt;
      this.syncConversationDirection(input.conversationId);
      return { ...existing };
    }

    if (input.idempotencyKey) {
      const racedWinner = this.rows.find((r) => r.idempotencyKey === input.idempotencyKey);
      if (racedWinner) return { ...racedWinner };
    }

    const row: ChatMessageRecord = {
      id: randomUUID(),
      conversationId: input.conversationId,
      chatwootMessageId: null,
      origin: 'agent_template',
      campaignRecipientId: null,
      direction: 'outbound',
      content: input.content,
      senderName: input.senderName ?? null,
      chatwootCreatedAt: input.chatwootCreatedAt,
      isPrivate: false,
      createdAt: new Date().toISOString(),
      providerMessageId: input.providerMessageId,
      idempotencyKey: input.idempotencyKey ?? null,
      // messaging-inbox-notes — un mensaje template one-off NUNCA es una nota interna.
      authorId: null,
      editedAt: null,
      deletedAt: null,
      deliveryStatus: null,
      deliveryError: null,
    };
    this.rows.push(row);
    this.syncConversationDirection(input.conversationId);
    return { ...row };
  }

  /**
   * H1 (fix wave, idempotency-key server-side) — fast-path lookup usado por
   * `SendTemplateMessage` ANTES de invocar `sendTemplate` (guard 0).
   */
  async findByIdempotencyKey(idempotencyKey: string): Promise<ChatMessageRecord | null> {
    const row = this.rows.find((r) => r.idempotencyKey === idempotencyKey);
    return row ? { ...row } : null;
  }

  async listByConversation(conversationId: string): Promise<ChatMessageRecord[]> {
    // INBOX-3: chatwootCreatedAt ASC, id ASC as a tiebreaker (§8) — MUST mirror
    // `PrismaChatMessageRepository.listByConversation`'s `orderBy` array exactly
    // (same rationale as `InMemoryConversationRepository.list`'s tiebreaker).
    return this.rows
      .filter((r) => r.conversationId === conversationId)
      .sort((a, b) => {
        const byDate = a.chatwootCreatedAt.localeCompare(b.chatwootCreatedAt);
        if (byDate !== 0) return byDate;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      })
      .map((r) => ({ ...r }));
  }

  async findById(id: string): Promise<ChatMessageRecord | null> {
    const row = this.rows.find((r) => r.id === id);
    return row ? { ...row } : null;
  }

  /**
   * conversation-events (Ola 2, reports/traffic) — mensajes INBOUND en `[fromIso, toIso)`
   * agrupados por día-de-semana × hora en zona AR (UTC-3, `toArgentinaDowHour`). MUST mirror
   * `PrismaChatMessageRepository.inboundTrafficByDowHour`. Sólo celdas con count>0.
   */
  async inboundTrafficByDowHour(fromIso: string, toIso: string): Promise<TrafficCell[]> {
    const from = new Date(fromIso).getTime();
    const to = new Date(toIso).getTime();
    const cells = new Map<string, TrafficCell>();
    for (const r of this.rows) {
      if (r.direction !== 'inbound') continue;
      const t = new Date(r.chatwootCreatedAt).getTime();
      if (t < from || t >= to) continue;
      const { dow, hour } = toArgentinaDowHour(r.chatwootCreatedAt);
      const key = `${dow}:${hour}`;
      const cell = cells.get(key);
      if (cell) cell.count += 1;
      else cells.set(key, { dow, hour, count: 1 });
    }
    return Array.from(cells.values()).sort((a, b) => (a.dow - b.dow) || (a.hour - b.hour));
  }

  /**
   * messaging-inbox-notes (edit/delete) — content + editedAt. NO cambia el contador
   * (editar no crea ni borra una nota). Autorización ya validada por EditInternalNote.
   */
  async updateContent(id: string, content: string, editedAt: string): Promise<ChatMessageRecord | null> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return null;
    row.content = content;
    row.editedAt = editedAt;
    return { ...row };
  }

  /**
   * messaging-inbox-notes (edit/delete) — soft-delete: setea deletedAt, NUNCA borra la
   * fila (el hilo la sigue devolviendo). Recalcula internalNoteCount (choke point).
   */
  async softDelete(id: string, deletedAt: string): Promise<ChatMessageRecord | null> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return null;
    row.deletedAt = deletedAt;
    this.syncInternalNoteCount(row.conversationId);
    return { ...row };
  }
}
