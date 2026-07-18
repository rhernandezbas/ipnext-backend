import {
  ConversationMentionRepository,
  ConversationMentionRecord,
  RecordConversationMentionInput,
} from '@domain/ports/ConversationMentionRepository';
import { prisma } from '../../database/prisma';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string | null {
  if (value instanceof Date) return value.toISOString();
  return (value as string | null) ?? null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toDomain(row: any): ConversationMentionRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    messageId: row.messageId,
    mentionedUserId: row.mentionedUserId,
    mentionedByUserId: row.mentionedByUserId ?? null,
    createdAt: toIso(row.createdAt)!,
    readAt: toIso(row.readAt),
  };
}

/**
 * note-mentions (Ola 6b) — Prisma adapter para `ConversationMentionRepository`. No
 * unit-tested (misma convención que el resto de adapters Prisma del módulo): el contrato se
 * ejercita vía el port in-memory en los tests de use-case; acá se verifica en integración.
 *
 * `record` usa `upsert` sobre el `@@unique([messageId, mentionedUserId])` para la
 * idempotencia (re-registrar la misma mención no duplica ni pisa el `readAt` ya seteado — el
 * `update` es no-op deliberado).
 */
export class PrismaConversationMentionRepository implements ConversationMentionRepository {
  async record(input: RecordConversationMentionInput): Promise<ConversationMentionRecord> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).conversationMention.upsert({
      where: {
        messageId_mentionedUserId: {
          messageId: input.messageId,
          mentionedUserId: input.mentionedUserId,
        },
      },
      create: {
        conversationId: input.conversationId,
        messageId: input.messageId,
        mentionedUserId: input.mentionedUserId,
        mentionedByUserId: input.mentionedByUserId ?? null,
      },
      // No-op idempotente: una mención ya registrada NO se pisa (preserva readAt).
      update: {},
    });
    return toDomain(row);
  }

  async markReadForUser(conversationId: string, userId: string, readAtIso: string): Promise<number> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (prisma as any).conversationMention.updateMany({
      where: { conversationId, mentionedUserId: userId, readAt: null },
      data: { readAt: new Date(readAtIso) },
    });
    return result.count;
  }

  async listByConversation(conversationId: string): Promise<ConversationMentionRecord[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (prisma as any).conversationMention.findMany({
      where: { conversationId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return rows.map((r: any) => toDomain(r));
  }
}
