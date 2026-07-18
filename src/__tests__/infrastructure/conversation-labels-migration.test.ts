/**
 * conversation-labels (Ola 5) — assertion estática de la migración + pines de
 * contrato (patrón messaging-migration.test.ts). Anti-"deuda silenciosa": pinea la
 * migración (2 CREATE TABLE + FKs Cascade + unique de la join + seed idempotente),
 * el schema (models nuevos), y el mapeo de codes en errorHandler.ts.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Migración 20260927000100_conversation_labels', () => {
  let sql: string;

  beforeAll(() => {
    sql = readFileSync(
      join(__dirname, '..', '..', '..', 'prisma', 'migrations', '20260927000100_conversation_labels', 'migration.sql'),
      'utf8',
    );
  });

  it('crea las 2 tablas (catálogo + join)', () => {
    expect(sql).toMatch(/CREATE TABLE "ConversationLabel"/);
    expect(sql).toMatch(/CREATE TABLE "ConversationLabelAssignment"/);
  });

  it('el color tiene default token del design system (#6366f1)', () => {
    expect(sql).toMatch(/"color" TEXT NOT NULL DEFAULT '#6366f1'/);
  });

  it('ConversationLabel.name es UNIQUE (dedup del catálogo)', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX "ConversationLabel_name_key" ON "ConversationLabel"\("name"\)/);
  });

  it('la join tiene UNIQUE compuesto (conversationId, labelId) — idempotencia de asignación', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "ConversationLabelAssignment_conversationId_labelId_key" ON "ConversationLabelAssignment"\("conversationId", "labelId"\)/,
    );
  });

  it('la join tiene índices por conversationId y labelId', () => {
    expect(sql).toMatch(/CREATE INDEX "ConversationLabelAssignment_conversationId_idx"/);
    expect(sql).toMatch(/CREATE INDEX "ConversationLabelAssignment_labelId_idx"/);
  });

  it('ambos FKs de la join son ON DELETE CASCADE (borrar conversación o label limpia la asignación)', () => {
    expect(sql).toMatch(
      /ALTER TABLE "ConversationLabelAssignment" ADD CONSTRAINT "ConversationLabelAssignment_conversationId_fkey" FOREIGN KEY \("conversationId"\) REFERENCES "Conversation"\("id"\) ON DELETE CASCADE ON UPDATE CASCADE/,
    );
    expect(sql).toMatch(
      /ALTER TABLE "ConversationLabelAssignment" ADD CONSTRAINT "ConversationLabelAssignment_labelId_fkey" FOREIGN KEY \("labelId"\) REFERENCES "ConversationLabel"\("id"\) ON DELETE CASCADE ON UPDATE CASCADE/,
    );
  });

  it('seedea 4 labels default idempotentes (ON CONFLICT ("name") DO NOTHING)', () => {
    expect(sql).toMatch(/INSERT INTO "ConversationLabel"/);
    expect(sql).toMatch(/'Urgente'/);
    expect(sql).toMatch(/'Reclamo'/);
    expect(sql).toMatch(/'Ventas'/);
    expect(sql).toMatch(/'Seguimiento'/);
    expect(sql).toMatch(/ON CONFLICT \("name"\) DO NOTHING/);
  });

  it('sin BEGIN/COMMIT explícito (Prisma envuelve cada migración en su propia transacción)', () => {
    expect(sql).not.toMatch(/^\s*BEGIN\s*;/m);
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/m);
  });
});

describe('schema.prisma — models de conversation-labels', () => {
  let schema: string;

  beforeAll(() => {
    schema = readFileSync(join(__dirname, '..', '..', '..', 'prisma', 'schema.prisma'), 'utf8');
  });

  it('declara ConversationLabel y ConversationLabelAssignment', () => {
    expect(schema).toMatch(/model ConversationLabel \{/);
    expect(schema).toMatch(/model ConversationLabelAssignment \{/);
  });

  it('Conversation tiene la back-relation labelAssignments', () => {
    expect(schema).toMatch(/labelAssignments\s+ConversationLabelAssignment\[\]/);
  });
});

describe('errorHandler — codes de conversation-labels mapeados', () => {
  let handlerSrc: string;

  beforeAll(() => {
    handlerSrc = readFileSync(
      join(__dirname, '..', '..', 'infrastructure', 'http', 'middleware', 'errorHandler.ts'),
      'utf8',
    );
  });

  it('CONVERSATION_LABEL_NOT_FOUND → 404', () => {
    expect(handlerSrc).toMatch(/CONVERSATION_LABEL_NOT_FOUND:\s*404/);
  });

  it('CONVERSATION_LABEL_NAME_CONFLICT → 409', () => {
    expect(handlerSrc).toMatch(/CONVERSATION_LABEL_NAME_CONFLICT:\s*409/);
  });
});
