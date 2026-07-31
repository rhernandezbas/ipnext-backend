/**
 * ticket-messaging-migration.test.ts — assertion estática (molde
 * messaging-internal-notes-migration.test.ts) sobre
 * 20261029000000_ticket_messaging.
 *
 * F6 (fix wave, MEDIUM): `authorKind`/`visibility` se agregaban NULLABLE, se
 * backfilleaban, y RECIÉN DESPUÉS se marcaban NOT NULL — SIN DEFAULT. En el
 * pipeline, `migrate deploy` corre ANTES del swap del container: en esa
 * ventana, el código VIEJO (que no conoce estas columnas) sigue insertando
 * TicketComment sin especificarlas — sin DEFAULT, cualquier INSERT de esa
 * ventana revienta con NOT NULL violation y `POST /api/tickets/:id/comments`
 * queda en 500. El fix agrega `DEFAULT 'staff'` / `DEFAULT 'internal'` desde
 * el `ADD COLUMN` — el mismo valor SEGURO que ya usa el backfill de abajo.
 *
 * G5 (fix wave FINAL) había intentado sacar el DEFAULT del schema Y agregar
 * una migración de seguimiento (20261029000100_ticket_comment_drop_defaults)
 * con el DROP DEFAULT en ESTE MISMO release. Corrección posterior (orden de
 * deploy): `prisma migrate deploy` aplica TODAS las migraciones pendientes
 * de una sola pasada, ANTES del swap del container — con las dos migraciones
 * en la misma branch, el DEFAULT se agregaba y se borraba en el MISMO
 * deploy, reabriendo la ventana que estaba destinado a proteger. Se revirtió
 * G5: la migración de seguimiento se sacó de esta branch y `schema.prisma`
 * vuelve a tener `@default(staff)`/`@default(internal)` (schema y DB
 * consistentes tras ESTE deploy). El DROP DEFAULT queda pendiente para un
 * deploy FUTURO, una vez que el código de este release esté corriendo en
 * todas las instancias — ver el docstring de `TicketComment` en
 * `prisma/schema.prisma` y el spec de `portal-ticket-messaging`.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Migración 20261029000000_ticket_messaging', () => {
  let sql: string;

  beforeAll(() => {
    sql = readFileSync(
      join(__dirname, '..', '..', '..', 'prisma', 'migrations', '20261029000000_ticket_messaging', 'migration.sql'),
      'utf8',
    );
  });

  it('F6: authorKind se agrega con DEFAULT \'staff\' (protege el INSERT del código viejo durante la ventana de deploy)', () => {
    expect(sql).toMatch(/ADD COLUMN\s+"authorKind"\s+"TicketCommentAuthorKind"\s+DEFAULT\s+'staff'/);
  });

  it('F6: visibility se agrega con DEFAULT \'internal\' (el lado SEGURO — mismo criterio que el backfill)', () => {
    expect(sql).toMatch(/ADD COLUMN\s+"visibility"\s+"TicketCommentVisibility"\s+DEFAULT\s+'internal'/);
  });

  it('el backfill sigue existiendo (el DEFAULT no reemplaza el backfill: las filas YA existentes no lo reciben retroactivamente)', () => {
    expect(sql).toMatch(/UPDATE "TicketComment" SET "authorKind" = 'staff', "visibility" = 'internal';/);
  });

  it('authorKind/visibility terminan NOT NULL (después del backfill, ahora que ya no hay NULLs)', () => {
    expect(sql).toMatch(/ALTER COLUMN "authorKind" SET NOT NULL/);
    expect(sql).toMatch(/ALTER COLUMN "visibility" SET NOT NULL/);
  });

  it('authorId sigue NULLABLE a propósito (opcional incluso en altas nuevas) — sin NOT NULL ni DEFAULT', () => {
    expect(sql).toMatch(/ADD COLUMN\s+"authorId" TEXT,/);
    expect(sql).not.toMatch(/"authorId"[^,]*NOT NULL/);
  });

  it('índice del invariante central: (ticketId, visibility)', () => {
    expect(sql).toMatch(/CREATE INDEX "TicketComment_ticketId_visibility_idx" ON "TicketComment"\("ticketId", "visibility"\)/);
  });

  it('sin BEGIN/COMMIT explícito (Prisma envuelve cada migración en su propia transacción)', () => {
    expect(sql).not.toMatch(/^\s*BEGIN\s*;/m);
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/m);
  });
});

describe('corrección de orden de deploy — schema.prisma SÍ tiene @default en authorKind/visibility (consistente con la DB tras este deploy)', () => {
  let schema: string;

  beforeAll(() => {
    schema = readFileSync(join(__dirname, '..', '..', '..', 'prisma', 'schema.prisma'), 'utf8');
  });

  it("el campo authorKind del modelo TicketComment lleva @default(staff) — protege la ventana de deploy; el DROP DEFAULT queda para un release futuro", () => {
    const line = schema.split('\n').find((l) => /^\s*authorKind\s+TicketCommentAuthorKind\b/.test(l));
    expect(line).toBeDefined();
    expect(line).toMatch(/@default\(staff\)/);
  });

  it("el campo visibility del modelo TicketComment lleva @default(internal) — mismo criterio SEGURO que el backfill", () => {
    const line = schema.split('\n').find((l) => /^\s*visibility\s+TicketCommentVisibility\b/.test(l));
    expect(line).toBeDefined();
    expect(line).toMatch(/@default\(internal\)/);
  });
});
