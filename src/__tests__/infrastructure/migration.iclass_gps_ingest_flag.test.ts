/**
 * Migration SQL-text snapshot test — seed del feature flag 'iclass-gps-ingest'.
 *
 * El change `iclass-gps-audit` se mergeó y deployó SIN la fila del flag en la tabla
 * FeatureFlag. Consecuencia medida en producción: `SELECT key FROM "FeatureFlag"`
 * devuelve 27 filas y 'iclass-gps-ingest' NO está entre ellas, así que la feature es
 * IMPOSIBLE de activar:
 *   - SetFeatureFlag hace `get` + throw FeatureFlagNotFoundError (NO upsert),
 *   - errorHandler mapea FLAG_NOT_FOUND a 404,
 *   - featureFlags.routes expone GET / GET/:key / PATCH/:key — no hay POST.
 * O sea: no existe vía por API para crear la fila. Sólo la puede sembrar una migración.
 *
 * Esta migración la siembra en FALSE (DARK — el scheduler re-lee el flag en cada tick,
 * así que sembrarla apagada no cambia ni un byte del comportamiento observable) y es
 * idempotente vía ON CONFLICT DO NOTHING sobre el PK `key`.
 *
 * Mirrors el patrón de los flags hermanos: 20260825000000_pppoe_auto_move_flag,
 * 20260917000100_radius_auto_cure_flag, 20260924000000_fiber_auto_watcher.
 * NAME RULE: 'iclass_gps_ingest_flag' no colisiona con ningún filtro de otros snapshot
 * tests (el más cercano, migration.iclass_returns, filtra por '_iclass_returns').
 */
import * as fs from 'fs';
import * as path from 'path';

describe('Migration: iclass_gps_ingest_flag', () => {
  let migrationSql: string;
  /** SQL con los comentarios `--` removidos: las aserciones negativas se corren acá
   *  para que una palabra en un comentario no dé un falso verde/rojo. */
  let sqlNoComments: string;
  let dirName: string;

  beforeAll(() => {
    const migrationsDir = path.resolve(__dirname, '../../../prisma/migrations');
    const dirs = fs
      .readdirSync(migrationsDir)
      .filter(d => d.endsWith('_iclass_gps_ingest_flag'));
    expect(dirs.length).toBe(1);
    dirName = dirs[0]!;
    const migrationFile = path.join(migrationsDir, dirs[0]!, 'migration.sql');
    expect(fs.existsSync(migrationFile)).toBe(true);
    migrationSql = fs.readFileSync(migrationFile, 'utf-8');
    sqlNoComments = migrationSql.replace(/--[^\n]*/g, '');
  });

  it('timestamp POSTERIOR a la última migración aplicada (20261025000100_technicians_location_permissions)', () => {
    expect(dirName.slice(0, 14) > '20261025000100').toBe(true);
  });

  it("siembra el flag 'iclass-gps-ingest' en FALSE (DARK — no lo prende)", () => {
    expect(sqlNoComments).toMatch(/INSERT INTO "FeatureFlag"/);
    expect(sqlNoComments).toMatch(/'iclass-gps-ingest',\s*false/);
    // Ni por accidente en true: prenderlo acá arrancaría el ingest contra IClass en el deploy.
    expect(sqlNoComments).not.toMatch(/'iclass-gps-ingest',\s*true/);
  });

  it('usa las columnas reales del modelo FeatureFlag (key, enabled, updatedAt) y ninguna inventada', () => {
    expect(sqlNoComments).toMatch(
      /INSERT INTO "FeatureFlag"\s*\(\s*"key",\s*"enabled",\s*"updatedAt"\s*\)/,
    );
    // La lista de columnas sola NO alcanza: un VALUES con menos valores que
    // columnas (p. ej. sin NOW()) pasaba todas las demás aserciones. Postgres
    // lo rechaza con 42601, así que falla ruidoso en el deploy — pero un gate
    // que se entera recién en producción no es un gate. La tupla se asevera
    // completa: tres valores, en orden, y `updatedAt` con NOW().
    expect(sqlNoComments).toMatch(
      /VALUES\s*\(\s*'iclass-gps-ingest',\s*false,\s*NOW\(\)\s*\)/,
    );
    // FeatureFlag no tiene `description` ni `id`: el PK es `key`.
    expect(sqlNoComments).not.toMatch(/"description"/);
    expect(sqlNoComments).not.toMatch(/gen_random_uuid\(\)/);
  });

  it('el seed es IDEMPOTENTE: ON CONFLICT DO NOTHING (re-deploy y doble corrida seguros)', () => {
    expect(sqlNoComments).toMatch(/ON CONFLICT\s+DO NOTHING/);
  });

  it('es ADITIVA: sólo inserta en FeatureFlag — no dropea, no altera, no borra', () => {
    expect(sqlNoComments).not.toMatch(/DROP /i);
    expect(sqlNoComments).not.toMatch(/ALTER TABLE/i);
    expect(sqlNoComments).not.toMatch(/CREATE TABLE/i);
    expect(sqlNoComments).not.toMatch(/UPDATE /i);
    expect(sqlNoComments).not.toMatch(/DELETE /i);
    expect(sqlNoComments).not.toMatch(/TRUNCATE/i);
    // Una sola sentencia: no toca ninguna otra tabla.
    expect(sqlNoComments.match(/INSERT INTO/gi)?.length).toBe(1);
  });

  it('no contiene BEGIN ni COMMIT (Prisma envuelve en su propia transacción)', () => {
    expect(sqlNoComments).not.toMatch(/^\s*BEGIN\s*;/im);
    expect(sqlNoComments).not.toMatch(/^\s*COMMIT\s*;/im);
  });

  it("el key sembrado es EXACTAMENTE el que lee el scheduler (TeamLocationIngestScheduler)", () => {
    const schedulerSrc = fs.readFileSync(
      path.resolve(__dirname, '../../infrastructure/scheduling/TeamLocationIngestScheduler.ts'),
      'utf-8',
    );
    const match = schedulerSrc.match(/const FLAG_KEY = '([^']+)'/);
    expect(match).not.toBeNull();
    const flagKey = match![1]!;
    expect(sqlNoComments).toContain(`'${flagKey}'`);
  });
});
