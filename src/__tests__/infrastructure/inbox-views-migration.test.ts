/**
 * inbox-views-migration.test.ts (Ola 1, MODEL-1) — assertion estática (molde
 * messaging-bulk-inbox-migration.test.ts). Pinea la migración
 * 20260925000000_conversation_last_public_message_direction: ADITIVA (ADD COLUMN
 * nullable + CREATE INDEX) + backfill set-based desde el último ChatMessage
 * NO-privado por conversación (DISTINCT ON + ORDER BY chatwootCreatedAt DESC,
 * id DESC — el MISMO criterio de "último público" que el recompute de
 * `PrismaChatMessageRepository.syncConversationDirection`, no pueden divergir),
 * SIN guard/RAISE EXCEPTION, sin BEGIN/COMMIT.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Migración 20260925000000_conversation_last_public_message_direction (inbox-views Ola 1)', () => {
  let sql: string;

  beforeAll(() => {
    sql = readFileSync(
      join(
        __dirname,
        '..',
        '..',
        '..',
        'prisma',
        'migrations',
        '20260925000000_conversation_last_public_message_direction',
        'migration.sql',
      ),
      'utf8',
    );
  });

  it('Conversation: agrega lastPublicMessageDirection como TEXT nullable (aditiva, sin default — null = sin mensajes públicos)', () => {
    expect(sql).toMatch(/ALTER TABLE "Conversation" ADD COLUMN\s+"lastPublicMessageDirection" TEXT/);
    // Nullable de verdad: la columna nueva jamás lleva NOT NULL.
    expect(sql).not.toMatch(/"lastPublicMessageDirection" TEXT NOT NULL/);
  });

  it('índice sobre lastPublicMessageDirection (el filtro/count del bucket Sin atender lo recorre por request)', () => {
    expect(sql).toMatch(
      /CREATE INDEX "Conversation_lastPublicMessageDirection_idx" ON "Conversation"\("lastPublicMessageDirection"\)/,
    );
  });

  it('backfill: UPDATE set-based desde el último ChatMessage NO-privado (DISTINCT ON + chatwootCreatedAt DESC, id DESC)', () => {
    expect(sql).toMatch(/UPDATE "Conversation"[\s\S]*SET "lastPublicMessageDirection"/);
    expect(sql).toMatch(/SELECT DISTINCT ON \("conversationId"\)/);
    // Solo mensajes públicos: una nota interna jamás define la dirección.
    expect(sql).toMatch(/WHERE "isPrivate" = false/);
    // Último = chatwootCreatedAt DESC con tiebreak id DESC — espejo EXACTO del
    // orderBy del recompute del adapter (y del listByConversation ASC invertido).
    expect(sql).toMatch(/ORDER BY "conversationId", "chatwootCreatedAt" DESC, "id" DESC/);
  });

  it('sin guard/RAISE EXCEPTION (best-effort, jamás aborta el deploy) y sin BEGIN/COMMIT explícito', () => {
    expect(sql).not.toMatch(/RAISE EXCEPTION/i);
    expect(sql).not.toMatch(/^\s*BEGIN\s*;/m);
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/m);
  });
});
