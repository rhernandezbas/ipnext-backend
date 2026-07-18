import {
  ChatMessageRepository,
  ChatMessageRecord,
  UpsertChatMessageInput,
  UpsertBulkChatMessageInput,
  UpsertTemplateChatMessageInput,
  TrafficCell,
} from '@domain/ports/ChatMessageRepository';
import { prisma } from '../../database/prisma';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string {
  return value instanceof Date ? value.toISOString() : (value as string);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toDomain(row: any): ChatMessageRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    chatwootMessageId: row.chatwootMessageId ?? null,
    origin: row.origin ?? 'chatwoot',
    campaignRecipientId: row.campaignRecipientId ?? null,
    direction: row.direction,
    content: row.content,
    senderName: row.senderName ?? null,
    chatwootCreatedAt: toIso(row.chatwootCreatedAt),
    createdAt: toIso(row.createdAt),
    isPrivate: row.isPrivate ?? false,
    providerMessageId: row.providerMessageId ?? null,
    idempotencyKey: row.idempotencyKey ?? null,
    authorId: row.authorId ?? null,
    editedAt: row.editedAt ? toIso(row.editedAt) : null,
    deletedAt: row.deletedAt ? toIso(row.deletedAt) : null,
  };
}

/**
 * messaging-inbox (F1) — Prisma adapter for `ChatMessageRepository`.
 * Not unit-tested (design/tasks §B2): the contract is exercised via the
 * in-memory port in use-case tests; this adapter is verified in integration.
 */
export class PrismaChatMessageRepository implements ChatMessageRepository {
  /**
   * inbox-views (Ola 1, VIEW-1 · fix wave M1/M2/L2) — mantiene el cache
   * desnormalizado `Conversation.lastPublicMessageDirection` tras CADA write de
   * mensaje. Este adapter es el CHOKE POINT: los 5 write-paths de producción
   * (webhook, fetch-on-open, send del agente, proyección bulk, template one-off)
   * pasan TODOS por los 3 upserts de abajo — mantenerlo acá cubre cualquier
   * caller presente o futuro por construcción.
   *
   * M1 — recompute ATÓMICO en UN SOLO statement: CTE del último mensaje
   * NO-privado por (chatwootCreatedAt DESC, id DESC — orden invertido de
   * `listByConversation`, mismo criterio que el `DISTINCT ON` del backfill de la
   * migración 20260925000000) + UPDATE. Un statement = snapshot consistente, SIN
   * ventana read→write: la versión anterior (findFirst + update separados) podía
   * quedar stale ante interleaving concurrente (webhook inbound ↔ send del
   * agente → "Sin atender" mostrando una conversación ya atendida). Converge por
   * recompute atómico: cada write recalcula desde la DB, nunca "último write
   * gana". Sin mensajes públicos el subselect da NULL → SET NULL (comportamiento
   * de siempre). Una nota interna (isPrivate) queda excluida: jamás cuenta como
   * atención (NOTE-3).
   *
   * M2 — FAIL-OPEN (best-effort): este sync corre DESPUÉS de que el ChatMessage
   * (la fuente de verdad) commiteó — y en SendMessage el WhatsApp REAL ya salió
   * por el gateway. Si el sync explotara hacia arriba: 500 al operador → retry
   * manual → mensaje DUPLICADO al cliente (el send normal NO tiene idempotency
   * key). Por eso try/catch + console.error (mismo criterio fail-open que
   * `maybeRegisterOptOut`/`captureAttachments`): el cache queda stale hasta el
   * próximo write de la conversación, que lo self-heals (recompute total, no
   * incremental).
   *
   * L2 — `IS DISTINCT FROM` (NULL-safe): si la dirección no cambió (ej. nota
   * privada repetida) el UPDATE matchea 0 filas → no re-escribe la tupla. Nota:
   * `$executeRaw` NO bumpea `updatedAt` (el `@updatedAt` de Prisma es
   * client-side, no un trigger) — deliberado: el cache es metadata derivada, no
   * "actividad" de la conversación.
   *
   * Cross-ref: `InMemoryChatMessageRepository.syncConversationDirection` — ambos
   * adapters NO pueden divergir (in-memory es síncrono single-threaded: atómico
   * por construcción, sin fail-open porque no puede fallar). Degradación
   * conocida: si un mensaje MIGRARA de conversación (no ocurre en ningún flujo
   * real), la conversación vieja queda stale hasta su próximo write.
   */
  private async syncConversationDirection(conversationId: string): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (prisma as any).$executeRaw`
        WITH last AS (
          SELECT m."direction"
          FROM "ChatMessage" m
          WHERE m."conversationId" = ${conversationId} AND m."isPrivate" = false
          ORDER BY m."chatwootCreatedAt" DESC, m."id" DESC
          LIMIT 1
        )
        UPDATE "Conversation" c
        SET "lastPublicMessageDirection" = (SELECT "direction" FROM last)
        WHERE c."id" = ${conversationId}
          AND c."lastPublicMessageDirection" IS DISTINCT FROM (SELECT "direction" FROM last)
      `;
    } catch (err) {
      // M2 — fail-open: el mensaje YA commiteó (y el WhatsApp real ya salió en el
      // caso de SendMessage) — este cache jamás puede tumbar ese write. Se loguea
      // y sigue; el próximo write de la conversación lo recomputa entero.
      // eslint-disable-next-line no-console
      console.error(
        '[messaging] sync de lastPublicMessageDirection falló (fail-open: el mensaje ya commiteó, el cache self-heals en el próximo write)',
        { conversationId, error: err instanceof Error ? err.message : err },
      );
    }
  }

  /**
   * messaging-inbox-notes (edit/delete, COUNT) — recompute ATÓMICO del contador
   * desnormalizado `Conversation.internalNoteCount` en UN solo statement (COUNT de
   * notas VIVAS: isPrivate=true AND deletedAt IS NULL). MISMO criterio que
   * `syncConversationDirection`: recompute total (self-healing, no incremental) +
   * FAIL-OPEN (el ChatMessage ya commiteó — este cache jamás puede tumbar ese write) +
   * `IS DISTINCT FROM` para no re-escribir la tupla si el count no cambió. Cross-ref:
   * `InMemoryChatMessageRepository.syncInternalNoteCount` — no pueden divergir.
   */
  private async syncInternalNoteCount(conversationId: string): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (prisma as any).$executeRaw`
        UPDATE "Conversation" c
        SET "internalNoteCount" = (
          SELECT COUNT(*)::int
          FROM "ChatMessage" m
          WHERE m."conversationId" = ${conversationId}
            AND m."isPrivate" = true
            AND m."deletedAt" IS NULL
        )
        WHERE c."id" = ${conversationId}
          AND c."internalNoteCount" IS DISTINCT FROM (
            SELECT COUNT(*)::int
            FROM "ChatMessage" m
            WHERE m."conversationId" = ${conversationId}
              AND m."isPrivate" = true
              AND m."deletedAt" IS NULL
          )
      `;
    } catch (err) {
      // FAIL-OPEN — mismo criterio que syncConversationDirection: el mensaje YA commiteó,
      // el cache se auto-repara en el próximo write de la conversación.
      // eslint-disable-next-line no-console
      console.error(
        '[messaging] sync de internalNoteCount falló (fail-open: el mensaje ya commiteó, self-heals en el próximo write)',
        { conversationId, error: err instanceof Error ? err.message : err },
      );
    }
  }

  async upsertByChatwootMessageId(input: UpsertChatMessageInput): Promise<ChatMessageRecord> {
    // messaging-inbox-notes (HIGH) — una nota EDITADA localmente (editedAt != null) es la
    // fuente de verdad LOCAL: `GetConversation.syncFromChatwoot` re-espeja el content
    // ORIGINAL de Chatwoot en CADA apertura (INBOX-2) vía este upsert, y la rama UPDATE
    // pisaría `content` → la edición se revertiría en DB. Pre-leemos `editedAt`: si la fila
    // ya fue editada por nosotros, la rama UPDATE OMITE `content` (y `editedAt` ya no se
    // tocaba). Una nota NO editada sí refleja los cambios de Chatwoot (cero regresión).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existing = await (prisma as any).chatMessage.findUnique({
      where: { chatwootMessageId: input.chatwootMessageId },
      select: { editedAt: true },
    });
    const preserveLocalEdit = !!existing && existing.editedAt !== null;

    const updateData: Record<string, unknown> = {
      conversationId: input.conversationId,
      direction: input.direction,
      senderName: input.senderName ?? null,
      chatwootCreatedAt: new Date(input.chatwootCreatedAt),
      isPrivate: input.isPrivate ?? false,
    };
    // Sólo espejamos `content` cuando la fila NO fue editada localmente.
    if (!preserveLocalEdit) updateData['content'] = input.content;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).chatMessage.upsert({
      where: { chatwootMessageId: input.chatwootMessageId },
      create: {
        conversationId: input.conversationId,
        chatwootMessageId: input.chatwootMessageId,
        direction: input.direction,
        content: input.content,
        senderName: input.senderName ?? null,
        chatwootCreatedAt: new Date(input.chatwootCreatedAt),
        isPrivate: input.isPrivate ?? false,
        // messaging-inbox-notes (edit/delete) — authorId SET-ONCE en create (SendMessage
        // sólo lo pasa cuando isPrivate). El `update` NO lo toca: el echo idempotente del
        // webhook (mismo chatwootMessageId) jamás nulifica al autor. LOW-1 (documentado):
        // si un webhook message_created gana la carrera al upsert local del send, authorId
        // queda null → la nota sólo la edita/borra un supervisor (edge raro, no se fuerza).
        authorId: input.authorId ?? null,
      },
      update: updateData,
    });
    await this.syncConversationDirection(input.conversationId);
    // messaging-inbox-notes (COUNT) — sólo una nota privada mueve el contador.
    if (input.isPrivate) await this.syncInternalNoteCount(input.conversationId);
    return toDomain(row);
  }

  /**
   * messaging-bulk-inbox (F1, PROYECCIÓN) — idempotente por `campaignRecipientId`
   * (@unique). Un mensaje `outbound`/`origin:'bulk'`/`chatwootMessageId:null`.
   * Re-proyectar el mismo recipient actualiza la fila, NUNCA duplica.
   */
  async upsertBulkMessage(input: UpsertBulkChatMessageInput): Promise<ChatMessageRecord> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).chatMessage.upsert({
      where: { campaignRecipientId: input.campaignRecipientId },
      create: {
        conversationId: input.conversationId,
        chatwootMessageId: null,
        origin: 'bulk',
        campaignRecipientId: input.campaignRecipientId,
        direction: 'outbound',
        content: input.content,
        senderName: input.senderName ?? null,
        chatwootCreatedAt: new Date(input.chatwootCreatedAt),
        isPrivate: false,
      },
      update: {
        conversationId: input.conversationId,
        content: input.content,
        senderName: input.senderName ?? null,
        chatwootCreatedAt: new Date(input.chatwootCreatedAt),
      },
    });
    // inbox-views (VIEW-1) — el bulk también mueve el cache (outbound público).
    await this.syncConversationDirection(input.conversationId);
    return toDomain(row);
  }

  /**
   * inbox-template-send (PORT-1) — idempotente por `providerMessageId` (`@unique`,
   * SM sid de Twilio). Un mensaje `outbound`/`origin:'agent_template'`/
   * `chatwootMessageId:null`/`campaignRecipientId:null`. Cross-ref: MISMA semántica
   * que `InMemoryChatMessageRepository.upsertTemplateMessage` — no pueden divergir.
   *
   * H1 (fix wave, idempotency-key server-side) — `idempotencyKey` viaja SOLO en
   * `create` (set-once, nunca se pisa en `update`). Backstop de carrera: dos sends
   * REALES concurrentes generan `providerMessageId` DISTINTOS pero pueden compartir
   * la MISMA `idempotencyKey` → el segundo `create` choca el `@unique` de
   * `idempotencyKey` (Prisma `P2002`, `meta.target` incluye `'idempotencyKey'`).
   * En vez de propagar un 500, se recupera la fila GANADORA por
   * `findByIdempotencyKey` y se devuelve esa — cross-ref: misma semántica en
   * `InMemoryChatMessageRepository.upsertTemplateMessage`. Cualquier OTRO error
   * (incluido un P2002 en una columna distinta) propaga tal cual.
   */
  async upsertTemplateMessage(input: UpsertTemplateChatMessageInput): Promise<ChatMessageRecord> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const row = await (prisma as any).chatMessage.upsert({
        where: { providerMessageId: input.providerMessageId },
        create: {
          conversationId: input.conversationId,
          chatwootMessageId: null,
          origin: 'agent_template',
          campaignRecipientId: null,
          providerMessageId: input.providerMessageId,
          idempotencyKey: input.idempotencyKey ?? null,
          direction: 'outbound',
          content: input.content,
          senderName: input.senderName ?? null,
          chatwootCreatedAt: new Date(input.chatwootCreatedAt),
          isPrivate: false,
        },
        update: {
          conversationId: input.conversationId,
          content: input.content,
          senderName: input.senderName ?? null,
          chatwootCreatedAt: new Date(input.chatwootCreatedAt),
        },
      });
      // inbox-views (VIEW-1) — el template también mueve el cache (outbound
      // público). En el path de recuperación de carrera (catch de abajo) NO se
      // re-sincroniza: el upsert del ganador ya lo hizo (mismo criterio que el
      // racedWinner del in-memory).
      await this.syncConversationDirection(input.conversationId);
      return toDomain(row);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      if (
        input.idempotencyKey &&
        err?.code === 'P2002' &&
        Array.isArray(err?.meta?.target) &&
        err.meta.target.includes('idempotencyKey')
      ) {
        const winner = await this.findByIdempotencyKey(input.idempotencyKey);
        if (winner) return winner;
      }
      throw err;
    }
  }

  /**
   * H1 (fix wave, idempotency-key server-side) — fast-path lookup usado por
   * `SendTemplateMessage` ANTES de invocar `sendTemplate` (guard 0), y como
   * backstop de recuperación de `upsertTemplateMessage` tras una carrera.
   */
  async findByIdempotencyKey(idempotencyKey: string): Promise<ChatMessageRecord | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).chatMessage.findUnique({ where: { idempotencyKey } });
    return row ? toDomain(row) : null;
  }

  async listByConversation(conversationId: string): Promise<ChatMessageRecord[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (prisma as any).chatMessage.findMany({
      where: { conversationId },
      // INBOX-3: oldest first. `id` ASC is a §8 tiebreaker — Postgres gives NO
      // guarantee on row order for `chatwootCreatedAt` ties without a secondary
      // ORDER BY key; MUST mirror `InMemoryChatMessageRepository.listByConversation`'s
      // comparator exactly.
      orderBy: [{ chatwootCreatedAt: 'asc' }, { id: 'asc' }],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return rows.map((r: any) => toDomain(r));
  }

  async findById(id: string): Promise<ChatMessageRecord | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).chatMessage.findUnique({ where: { id } });
    return row ? toDomain(row) : null;
  }

  /**
   * messaging-inbox-notes (edit/delete) — content + editedAt. No toca el contador
   * (editar no crea ni borra). Autorización ya validada por `EditInternalNote`.
   */
  async updateContent(id: string, content: string, editedAt: string): Promise<ChatMessageRecord | null> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const row = await (prisma as any).chatMessage.update({
        where: { id },
        data: { content, editedAt: new Date(editedAt) },
      });
      return row ? toDomain(row) : null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      // LOW-3 — TOCTOU: la fila se borró entre el findById del use case y este update.
      // P2025 (record not found) → null (contrato del port, que el in-memory ya respeta),
      // NUNCA un 500. Cualquier otro error propaga.
      if (err?.code === 'P2025') return null;
      throw err;
    }
  }

  /**
   * messaging-inbox-notes (edit/delete) — soft-delete (setea deletedAt, NUNCA borra la
   * fila) + recompute del contador (choke point). Autorización ya validada por
   * `DeleteInternalNote`.
   */
  async softDelete(id: string, deletedAt: string): Promise<ChatMessageRecord | null> {
    let row;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      row = await (prisma as any).chatMessage.update({
        where: { id },
        data: { deletedAt: new Date(deletedAt) },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      // LOW-3 — TOCTOU: borrada entre findById y update → P2025 → null, nunca 500.
      if (err?.code === 'P2025') return null;
      throw err;
    }
    await this.syncInternalNoteCount(row.conversationId);
    return toDomain(row);
  }

  /**
   * conversation-events (Ola 2, reports/traffic) — heatmap de tráfico entrante: mensajes
   * INBOUND en `[fromIso, toIso)` agrupados por día-de-semana × hora en zona AR. Anti-N+1:
   * un solo GROUP BY (jamás trae filas ni scanea por celda).
   *
   * TIMEZONE (ver `reportsTimezone.ts`): `chatwootCreatedAt` es `timestamp` naive-UTC;
   * `AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires'` lo lleva a hora de pared
   * AR (equivale al -3h del helper in-memory — sin DST). EXTRACT(DOW) = 0 (domingo)…6; HOUR =
   * 0…23. El filtro por rango compara el instante crudo (`AT TIME ZONE 'UTC'` → timestamptz).
   * MUST mirror `InMemoryChatMessageRepository.inboundTrafficByDowHour`.
   */
  async inboundTrafficByDowHour(fromIso: string, toIso: string): Promise<TrafficCell[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: Array<{ dow: number; hour: number; count: number }> = await (prisma as any).$queryRaw`
      SELECT
        EXTRACT(DOW  FROM (m."chatwootCreatedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires'))::int AS dow,
        EXTRACT(HOUR FROM (m."chatwootCreatedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires'))::int AS hour,
        COUNT(*)::int AS count
      FROM "ChatMessage" m
      WHERE m."direction" = 'inbound'
        AND (m."chatwootCreatedAt" AT TIME ZONE 'UTC') >= ${fromIso}::timestamptz
        AND (m."chatwootCreatedAt" AT TIME ZONE 'UTC') <  ${toIso}::timestamptz
      GROUP BY 1, 2
      ORDER BY 1, 2
    `;
    return rows.map((r) => ({ dow: Number(r.dow), hour: Number(r.hour), count: Number(r.count) }));
  }
}
