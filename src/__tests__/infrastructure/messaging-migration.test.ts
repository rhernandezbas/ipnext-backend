/**
 * messaging-migration.test.ts — assertion estática (patrón actions-composition.test.ts).
 * Anti-"deuda silenciosa": pinea el schema (RBAC_MODULES/KNOWN_ACTIONS), las 2 migraciones
 * de B1 (mirror + permisos) y el mapeo de errores en errorHandler.ts.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe("RBAC — módulo 'messaging' + acción 'send' (rbac.ts)", () => {
  let rbacSrc: string;

  beforeAll(() => {
    rbacSrc = readFileSync(join(__dirname, '..', '..', 'domain', 'entities', 'rbac.ts'), 'utf8');
  });

  it("RBAC_MODULES declara 'messaging'", () => {
    expect(rbacSrc).toMatch(/'messaging',/);
  });

  it("KNOWN_ACTIONS declara 'send'", () => {
    expect(rbacSrc).toMatch(/'send',/);
  });
});

describe('Migración 20260904000000_messaging_mirror (B1: modelo + índices)', () => {
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
        '20260904000000_messaging_mirror',
        'migration.sql',
      ),
      'utf8',
    );
  });

  it('crea las 3 tablas del mirror', () => {
    expect(sql).toMatch(/CREATE TABLE "Conversation"/);
    expect(sql).toMatch(/CREATE TABLE "ChatMessage"/);
    expect(sql).toMatch(/CREATE TABLE "WebhookDelivery"/);
  });

  it('chatwootConversationId y chatwootMessageId son UNIQUE (idempotencia de upsert)', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX "Conversation_chatwootConversationId_key"/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX "ChatMessage_chatwootMessageId_key"/);
  });

  it('§9 — Conversation_lastMessageAt_idx está creado DESC NULLS LAST (matchea el orderBy DESC NULLS LAST de INBOX-1, no el default ASC)', () => {
    expect(sql).toMatch(/CREATE INDEX "Conversation_lastMessageAt_idx" ON "Conversation"\("lastMessageAt" DESC NULLS LAST\)/);
  });

  it('WebhookDelivery tiene UNIQUE compuesto (source, deliveryId) — dedup de entregas (HOOK-3)', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX "WebhookDelivery_source_deliveryId_key"/);
  });

  it('ChatMessage tiene FK a Conversation', () => {
    expect(sql).toMatch(/ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_conversationId_fkey"/);
  });

  it('sin BEGIN/COMMIT explícito (Prisma envuelve cada migración en su propia transacción)', () => {
    expect(sql).not.toMatch(/^\s*BEGIN\s*;/m);
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/m);
  });
});

describe('Migración 20260904000100_messaging_permissions (RBAC-3: seed idempotente)', () => {
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
        '20260904000100_messaging_permissions',
        'migration.sql',
      ),
      'utf8',
    );
  });

  it("seedea el módulo 'messaging'", () => {
    expect(sql).toMatch(/'messaging'/);
  });

  it('seedea permisos read y send del módulo', () => {
    expect(sql).toMatch(/'read'/);
    expect(sql).toMatch(/'send'/);
  });

  it('grants a super_admin Y administrador', () => {
    expect(sql).toMatch(/'super_admin'/);
    expect(sql).toMatch(/'administrador'/);
  });

  it('TODOS los INSERT son idempotentes: 7 INSERT (módulo + 2 permisos + 4 grants), cada uno con ON CONFLICT DO NOTHING', () => {
    const inserts = sql.match(/INSERT INTO/g) ?? [];
    const conflicts = sql.match(/ON CONFLICT[^;]*DO NOTHING/g) ?? [];
    expect(inserts).toHaveLength(7);
    expect(conflicts).toHaveLength(inserts.length);
  });

  it('sin BEGIN/COMMIT explícito (Prisma envuelve cada migración en su propia transacción)', () => {
    expect(sql).not.toMatch(/^\s*BEGIN\s*;/m);
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/m);
  });
});

describe('Migración 20260906000000_add_chat_message_is_private (messaging-inbox-notes, NOTE-1)', () => {
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
        '20260906000000_add_chat_message_is_private',
        'migration.sql',
      ),
      'utf8',
    );
  });

  it('agrega isPrivate como columna ADITIVA con default false (sin backfill)', () => {
    expect(sql).toMatch(/ALTER TABLE "ChatMessage" ADD COLUMN "isPrivate" BOOLEAN NOT NULL DEFAULT false/);
  });

  it('sin BEGIN/COMMIT explícito (Prisma envuelve cada migración en su propia transacción)', () => {
    expect(sql).not.toMatch(/^\s*BEGIN\s*;/m);
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/m);
  });
});

describe('Migración 20260907000000_add_conversation_assignment (F1.5-C2: assigneeId/areaId LOCALES)', () => {
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
        '20260907000000_add_conversation_assignment',
        'migration.sql',
      ),
      'utf8',
    );
  });

  it('agrega assigneeId y areaId como columnas ADITIVAS (sin backfill)', () => {
    expect(sql).toMatch(/ALTER TABLE "Conversation" ADD COLUMN\s+"assigneeId" TEXT/);
    expect(sql).toMatch(/ALTER TABLE "Conversation" ADD COLUMN\s+"areaId" TEXT/);
  });

  it('crea los índices de assigneeId y areaId', () => {
    expect(sql).toMatch(/CREATE INDEX "Conversation_assigneeId_idx" ON "Conversation"\("assigneeId"\)/);
    expect(sql).toMatch(/CREATE INDEX "Conversation_areaId_idx" ON "Conversation"\("areaId"\)/);
  });

  it('assigneeId es FK a RbacUser con ON DELETE SET NULL (clon del patrón Ticket.assigneeId)', () => {
    expect(sql).toMatch(
      /ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_assigneeId_fkey" FOREIGN KEY \("assigneeId"\) REFERENCES "RbacUser"\("id"\) ON DELETE SET NULL ON UPDATE CASCADE/,
    );
  });

  it('areaId es FK a TicketAreaCatalog con ON DELETE SET NULL (clon del patrón Ticket.areaId)', () => {
    expect(sql).toMatch(
      /ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_areaId_fkey" FOREIGN KEY \("areaId"\) REFERENCES "TicketAreaCatalog"\("id"\) ON DELETE SET NULL ON UPDATE CASCADE/,
    );
  });

  it('sin BEGIN/COMMIT explícito (Prisma envuelve cada migración en su propia transacción)', () => {
    expect(sql).not.toMatch(/^\s*BEGIN\s*;/m);
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/m);
  });
});

describe('errorHandler — codes nuevos de messaging mapeados (SEND-2/3, INBOX-2)', () => {
  let handlerSrc: string;

  beforeAll(() => {
    handlerSrc = readFileSync(
      join(__dirname, '..', '..', 'infrastructure', 'http', 'middleware', 'errorHandler.ts'),
      'utf8',
    );
  });

  it('CONVERSATION_NOT_FOUND → 404', () => {
    expect(handlerSrc).toMatch(/CONVERSATION_NOT_FOUND:\s*404/);
  });

  it('MESSAGING_WINDOW_EXPIRED → 422', () => {
    expect(handlerSrc).toMatch(/MESSAGING_WINDOW_EXPIRED:\s*422/);
  });

  it('CHATWOOT_UNAVAILABLE → 503', () => {
    expect(handlerSrc).toMatch(/CHATWOOT_UNAVAILABLE:\s*503/);
  });
});
