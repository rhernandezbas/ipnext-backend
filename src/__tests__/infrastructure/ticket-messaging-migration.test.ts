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
