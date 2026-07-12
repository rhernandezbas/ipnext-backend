/**
 * messaging-inbox-v2-media (F1.5 fase A, Tanda 1 · B1.2) — assertion estática sobre
 * la migración aditiva de `ChatMessageAttachment` (patrón `messaging-migration.test.ts`).
 * Spec MODEL-1, scenario 25 (migración limpia + FK cascade + unique constraint).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Migración 20260905000000_add_chat_message_attachment (MODEL-1)', () => {
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
        '20260905000000_add_chat_message_attachment',
        'migration.sql',
      ),
      'utf8',
    );
  });

  it('crea la tabla ChatMessageAttachment', () => {
    expect(sql).toMatch(/CREATE TABLE "ChatMessageAttachment"/);
  });

  it('chatwootAttachmentId es UNIQUE (idempotencia de upsert, scenario "duplicado — constraint")', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX "ChatMessageAttachment_chatwootAttachmentId_key"/);
  });

  it('índice por messageId (mapper sin N+1) y por status (barrido del scheduler)', () => {
    expect(sql).toMatch(/CREATE INDEX "ChatMessageAttachment_messageId_idx" ON "ChatMessageAttachment"\("messageId"\)/);
    expect(sql).toMatch(/CREATE INDEX "ChatMessageAttachment_status_idx" ON "ChatMessageAttachment"\("status"\)/);
  });

  it('FK a ChatMessage con ON DELETE CASCADE (scenario "FK cascade al borrar el mensaje")', () => {
    expect(sql).toMatch(
      /ALTER TABLE "ChatMessageAttachment" ADD CONSTRAINT "ChatMessageAttachment_messageId_fkey" FOREIGN KEY \("messageId"\) REFERENCES "ChatMessage"\("id"\) ON DELETE CASCADE/,
    );
  });

  it('status default pending, downloadAttempts default 0 (nuevas filas nacen pending sin intentos)', () => {
    expect(sql).toMatch(/"status" TEXT NOT NULL DEFAULT 'pending'/);
    expect(sql).toMatch(/"downloadAttempts" INTEGER NOT NULL DEFAULT 0/);
  });

  it('sin BEGIN/COMMIT explícito (Prisma envuelve cada migración en su propia transacción)', () => {
    expect(sql).not.toMatch(/^\s*BEGIN\s*;/m);
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/m);
  });
});

describe('Migración 20260905000100_chat_media_download_flag (MEDIA-3, dark by default)', () => {
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
        '20260905000100_chat_media_download_flag',
        'migration.sql',
      ),
      'utf8',
    );
  });

  it("seedea el flag 'chat-media-download' en false (dark by default)", () => {
    expect(sql).toMatch(/INSERT INTO "FeatureFlag"/);
    expect(sql).toMatch(/'chat-media-download',\s*false/);
  });

  it('idempotente — ON CONFLICT DO NOTHING', () => {
    expect(sql).toMatch(/ON CONFLICT DO NOTHING/);
  });
});

describe('errorHandler — codes de messaging-inbox-v2-media (chat attachments) mapeados', () => {
  let handlerSrc: string;

  beforeAll(() => {
    handlerSrc = readFileSync(
      join(__dirname, '..', '..', 'infrastructure', 'http', 'middleware', 'errorHandler.ts'),
      'utf8',
    );
  });

  it('CHAT_ATTACHMENT_TOO_LARGE → 413', () => {
    expect(handlerSrc).toMatch(/CHAT_ATTACHMENT_TOO_LARGE:\s*413/);
  });

  it('CHAT_ATTACHMENT_NOT_FOUND → 404', () => {
    expect(handlerSrc).toMatch(/CHAT_ATTACHMENT_NOT_FOUND:\s*404/);
  });

  it('CHAT_ATTACHMENT_NOT_READY → 409', () => {
    expect(handlerSrc).toMatch(/CHAT_ATTACHMENT_NOT_READY:\s*409/);
  });
});
