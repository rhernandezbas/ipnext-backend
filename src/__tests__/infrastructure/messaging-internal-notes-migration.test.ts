/**
 * messaging-internal-notes-migration.test.ts — assertion estática (molde
 * messaging-bulk-inbox-migration.test.ts) sobre 20260926000000_internal_notes_edit.
 * Pinea: aditiva (ADD COLUMN nullable / con DEFAULT + FK SetNull + índices) +
 * backfill best-effort del contador (COUNT de notas vivas) SIN guard/RAISE +
 * seed idempotente del permiso messaging.manage otorgado a super_admin+administrador,
 * sin BEGIN/COMMIT explícito.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Migración 20260926000000_internal_notes_edit', () => {
  let sql: string;

  beforeAll(() => {
    sql = readFileSync(
      join(__dirname, '..', '..', '..', 'prisma', 'migrations', '20260926000000_internal_notes_edit', 'migration.sql'),
      'utf8',
    );
  });

  it('ChatMessage: agrega authorId + editedAt + deletedAt como columnas aditivas nullable', () => {
    expect(sql).toMatch(/ALTER TABLE "ChatMessage" ADD COLUMN\s+"authorId" TEXT;/);
    expect(sql).toMatch(/ALTER TABLE "ChatMessage" ADD COLUMN\s+"editedAt" TIMESTAMP\(3\);/);
    expect(sql).toMatch(/ALTER TABLE "ChatMessage" ADD COLUMN\s+"deletedAt" TIMESTAMP\(3\);/);
    // aditivas puras: nunca NOT NULL sobre estas columnas nuevas (romperían filas históricas).
    expect(sql).not.toMatch(/ADD COLUMN\s+"authorId" TEXT NOT NULL/);
  });

  it('Conversation: agrega internalNoteCount NOT NULL DEFAULT 0 (desnormalizado)', () => {
    expect(sql).toMatch(/ALTER TABLE "Conversation" ADD COLUMN\s+"internalNoteCount" INTEGER NOT NULL DEFAULT 0;/);
  });

  it('FK authorId → RbacUser con ON DELETE SET NULL (borrar el usuario preserva la nota)', () => {
    expect(sql).toMatch(
      /ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_authorId_fkey" FOREIGN KEY \("authorId"\) REFERENCES "RbacUser"\("id"\) ON DELETE SET NULL/,
    );
  });

  it('índices: authorId + (conversationId, isPrivate) para el count de notas vivas', () => {
    expect(sql).toMatch(/CREATE INDEX "ChatMessage_authorId_idx" ON "ChatMessage"\("authorId"\)/);
    expect(sql).toMatch(
      /CREATE INDEX "ChatMessage_conversationId_isPrivate_idx" ON "ChatMessage"\("conversationId", "isPrivate"\)/,
    );
  });

  it('backfill del contador: COUNT de notas internas VIVAS (isPrivate=true AND deletedAt IS NULL), SIN guard/RAISE', () => {
    expect(sql).toMatch(/UPDATE "Conversation" c[\s\S]*SET "internalNoteCount" =/);
    expect(sql).toMatch(/m\."isPrivate" = true/);
    expect(sql).toMatch(/m\."deletedAt" IS NULL/);
    expect(sql).not.toMatch(/RAISE EXCEPTION/i);
  });

  it('seed idempotente del permiso messaging.manage (INSERT ... ON CONFLICT DO NOTHING)', () => {
    expect(sql).toMatch(/INSERT INTO "RbacPermission"[\s\S]*'manage'[\s\S]*ON CONFLICT \("moduleId", "action"\) DO NOTHING/);
  });

  it('otorga messaging.manage a super_admin Y a administrador (el "supervisor"), idempotente', () => {
    expect(sql).toMatch(/WHERE r\."code" = 'super_admin'[\s\S]*p\."action" = 'manage'/);
    expect(sql).toMatch(/WHERE r\."code" = 'administrador'[\s\S]*p\."action" = 'manage'/);
    // ambos grants pasan por ON CONFLICT ("roleId", "permissionId") DO NOTHING.
    const grants = sql.match(/ON CONFLICT \("roleId", "permissionId"\) DO NOTHING/g) ?? [];
    expect(grants.length).toBeGreaterThanOrEqual(2);
  });

  it('sin BEGIN/COMMIT explícito (Prisma envuelve cada migración en su propia transacción)', () => {
    expect(sql).not.toMatch(/^\s*BEGIN\s*;/m);
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/m);
  });
});
