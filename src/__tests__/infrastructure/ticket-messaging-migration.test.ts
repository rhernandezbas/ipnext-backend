/**
 * ticket-messaging-migration.test.ts — assertion estática (molde
 * messaging-internal-notes-migration.test.ts) sobre
 * 20261029000000_ticket_messaging Y su migración de seguimiento
 * 20261029000100_ticket_comment_drop_defaults.
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
 * G5 (fix wave FINAL): el DEFAULT de F6 solo hacía falta durante la ventana
 * de deploy — dejarlo PERMANENTE en `schema.prisma` vuelve authorKind/
 * visibility opcionales para siempre en el input de `create` de Prisma (un
 * alta futura que se olvide de pasarlos compila igual y estampa 'staff' en
 * silencio). Este archivo (F6 original) ANTES solo asertaba el `.sql` — si
 * alguien volvía a agregar `@default` en `schema.prisma` sin la migración de
 * seguimiento, nada se ponía en rojo (el drift quedaba invisible hasta el
 * próximo `prisma migrate dev`, que lo detecta demasiado tarde). Las suites de
 * abajo cierran eso: aserta que `schema.prisma` NO tiene `@default` en esas
 * dos columnas, Y que la migración de seguimiento existe con el `DROP
 * DEFAULT` real.
 */
import { readFileSync, readdirSync } from 'fs';
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

describe('G5 (fix wave FINAL) — schema.prisma NO tiene @default permanente en authorKind/visibility', () => {
  let schema: string;

  beforeAll(() => {
    schema = readFileSync(join(__dirname, '..', '..', '..', 'prisma', 'schema.prisma'), 'utf8');
  });

  it('el campo authorKind del modelo TicketComment no lleva @default — revert-probe: agregarlo de vuelta pone este test en rojo', () => {
    const line = schema.split('\n').find((l) => /^\s*authorKind\s+TicketCommentAuthorKind\b/.test(l));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/@default/);
  });

  it('el campo visibility del modelo TicketComment no lleva @default — revert-probe: agregarlo de vuelta pone este test en rojo', () => {
    const line = schema.split('\n').find((l) => /^\s*visibility\s+TicketCommentVisibility\b/.test(l));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/@default/);
  });
});

describe('G5 (fix wave FINAL) — migración de seguimiento 20261029000100_ticket_comment_drop_defaults', () => {
  let sql: string;

  beforeAll(() => {
    sql = readFileSync(
      join(__dirname, '..', '..', '..', 'prisma', 'migrations', '20261029000100_ticket_comment_drop_defaults', 'migration.sql'),
      'utf8',
    );
  });

  it('DROP DEFAULT en authorKind — la migración de seguimiento saca el DEFAULT que la original agregó', () => {
    expect(sql).toMatch(/ALTER COLUMN "authorKind" DROP DEFAULT/);
  });

  it('DROP DEFAULT en visibility', () => {
    expect(sql).toMatch(/ALTER COLUMN "visibility" DROP DEFAULT/);
  });

  it('el timestamp de la migración de seguimiento es MAYOR al de la original (aplica DESPUÉS, nunca antes)', () => {
    const original = '20261029000000_ticket_messaging';
    const followUp = '20261029000100_ticket_comment_drop_defaults';
    expect(followUp.localeCompare(original)).toBeGreaterThan(0);
  });

  it('es la migración MÁS NUEVA del repo (ningún otro directorio de prisma/migrations la supera) — sin drift de orden', () => {
    const migrationsDir = join(__dirname, '..', '..', '..', 'prisma', 'migrations');
    const entries = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(entries[entries.length - 1]).toBe('20261029000100_ticket_comment_drop_defaults');
  });
});
