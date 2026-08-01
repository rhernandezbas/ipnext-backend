/**
 * ticketCommentNoDefaults.schema.test.ts — guard del cierre del pendiente
 * G5→G12: `TicketComment.authorKind` y `.visibility` NO deben volver a tener
 * `@default`.
 *
 * POR QUÉ IMPORTA: con `@default`, Prisma deja los dos campos OPCIONALES en el
 * input de `create` PARA SIEMPRE. Un `create` futuro que se olvide de pasar
 * `authorKind` compila igual y estampa `'staff'` en silencio ⇒ un mensaje del
 * CLIENTE queda mostrado como si lo hubiera escrito soporte y no cuenta en
 * `countUnread`. Sin el default, ese olvido es un error de TIPOS.
 *
 * ⚠️ POR QUÉ ESTE TEST BORRA LOS COMENTARIOS ANTES DE MATCHEAR: el propio
 * docstring de `TicketComment` en `schema.prisma` MENCIONA la cadena
 * `@default(staff)` para explicar la historia del pendiente. Un test que
 * grepee el archivo crudo matchea ESE COMENTARIO y pasa (o falla) por el
 * motivo equivocado — quedaría verde con el default REALMENTE puesto, o rojo
 * sin él. Un test sobre el TEXTO de un archivo tiene que mirar el código, no
 * la prosa que lo rodea.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SCHEMA_PATH = join(__dirname, '..', '..', '..', 'prisma', 'schema.prisma');
const MIGRATION_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  'prisma',
  'migrations',
  '20261101000000_ticket_comment_drop_defaults',
  'migration.sql',
);

/** Saca los comentarios `//` de línea del schema (Prisma no tiene comentarios
 * de bloque) — ver la advertencia del docstring de arriba. */
function stripPrismaComments(source: string): string {
  return source
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

/** Devuelve el cuerpo del `model TicketComment { ... }`, ya sin comentarios. */
function ticketCommentModelBody(schema: string): string {
  const withoutComments = stripPrismaComments(schema);
  const match = withoutComments.match(/model\s+TicketComment\s*\{([\s\S]*?)\n\}/);
  if (!match) throw new Error('No se encontró el model TicketComment en schema.prisma');
  return match[1] as string;
}

describe('TicketComment: authorKind/visibility SIN @default (pendiente G5→G12 saldado)', () => {
  let modelBody: string;

  beforeAll(() => {
    modelBody = ticketCommentModelBody(readFileSync(SCHEMA_PATH, 'utf8'));
  });

  it('el helper que borra comentarios funciona (si no, todo este test miente)', () => {
    const fake = [
      'model TicketComment {',
      '  // historia: antes tenia authorKind TicketCommentAuthorKind @default(staff)',
      '  authorKind  TicketCommentAuthorKind',
      '}',
    ].join('\n');
    const body = ticketCommentModelBody(fake);
    expect(body).not.toMatch(/@default/);
    expect(body).toMatch(/authorKind\s+TicketCommentAuthorKind/);
  });

  it.each([
    ['authorKind', 'TicketCommentAuthorKind'],
    ['visibility', 'TicketCommentVisibility'],
  ])('%s se declara SIN @default', (field, type) => {
    const declaration = modelBody
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith(`${field} `));

    expect(declaration).toBeDefined();
    expect(declaration).toContain(type);
    expect(declaration).not.toContain('@default');
  });

  it('la migración que los saca existe y hace DROP DEFAULT de los DOS', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    expect(sql).toMatch(/ALTER TABLE "TicketComment" ALTER COLUMN "authorKind" DROP DEFAULT;/);
    expect(sql).toMatch(/ALTER TABLE "TicketComment" ALTER COLUMN "visibility" DROP DEFAULT;/);
  });

  it('la migración NO toca datos — un DROP DEFAULT no puede reescribir filas existentes', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    const statements = sql
      .split('\n')
      .map((l) => l.replace(/--.*$/, '').trim())
      .filter((l) => l.length > 0);

    expect(statements).toHaveLength(2);
    for (const statement of statements) {
      expect(statement).not.toMatch(/\b(UPDATE|DELETE|INSERT|TRUNCATE)\b/i);
    }
  });
});
