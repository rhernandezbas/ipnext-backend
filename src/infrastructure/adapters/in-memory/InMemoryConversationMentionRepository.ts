import { randomUUID } from 'crypto';
import {
  ConversationMentionRepository,
  ConversationMentionRecord,
  RecordConversationMentionInput,
} from '@domain/ports/ConversationMentionRepository';

/**
 * note-mentions (Ola 6b) — in-memory ConversationMentionRepository para use-case y route
 * tests. `record` es idempotente por `(messageId, mentionedUserId)`, espejo del `@@unique`
 * del schema Prisma.
 *
 * `hasUnreadMention` NO es parte del port: es el accessor SÍNCRONO que
 * `InMemoryConversationRepository` consulta (vía `linkMentions`) para resolver el filtro
 * `mentionedUserId` en `applyFilters`, espejo del `where.mentions = { some: { readAt: null } }`
 * que `PrismaConversationRepository.buildConversationWhere` expresa como subquery relacional.
 * En Postgres ambos "repos" comparten la misma DB; acá son stores separados y necesitan el
 * lazo explícito (mismo idioma live-link que `syncLastPublicMessageDirection`/`seedLabels`).
 */
export class InMemoryConversationMentionRepository implements ConversationMentionRepository {
  private rows: ConversationMentionRecord[] = [];

  async record(input: RecordConversationMentionInput): Promise<ConversationMentionRecord> {
    const existing = this.rows.find(
      (r) => r.messageId === input.messageId && r.mentionedUserId === input.mentionedUserId,
    );
    if (existing) return { ...existing };

    const row: ConversationMentionRecord = {
      id: randomUUID(),
      conversationId: input.conversationId,
      messageId: input.messageId,
      mentionedUserId: input.mentionedUserId,
      mentionedByUserId: input.mentionedByUserId ?? null,
      createdAt: new Date().toISOString(),
      readAt: null,
    };
    this.rows.push(row);
    return { ...row };
  }

  async markReadForUser(conversationId: string, userId: string, readAtIso: string): Promise<number> {
    let marked = 0;
    for (const row of this.rows) {
      if (row.conversationId === conversationId && row.mentionedUserId === userId && row.readAt === null) {
        row.readAt = readAtIso;
        marked += 1;
      }
    }
    return marked;
  }

  async listByConversation(conversationId: string): Promise<ConversationMentionRecord[]> {
    return this.rows
      .filter((r) => r.conversationId === conversationId)
      .sort((a, b) => {
        const byDate = a.createdAt.localeCompare(b.createdAt);
        if (byDate !== 0) return byDate;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      })
      .map((r) => ({ ...r }));
  }

  /**
   * note-mentions (Ola 6b) — accessor SÍNCRONO (NO es del port) consumido por
   * `InMemoryConversationRepository.applyFilters` para el filtro `mentionedUserId` de la
   * vista "Menciones". `true` si la conversación tiene alguna mención NO leída del usuario.
   */
  hasUnreadMention(conversationId: string, userId: string): boolean {
    return this.rows.some(
      (r) => r.conversationId === conversationId && r.mentionedUserId === userId && r.readAt === null,
    );
  }
}
