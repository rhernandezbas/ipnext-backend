/**
 * Migration SQL-text snapshot test — pppoe-preprovision-autoinstall (tasks 1.1, design D1/D2).
 * Verifica que la migración ADITIVA:
 *   - hace nullable PppoeService.nasId (pre-provisión = nasId NULL),
 *   - agrega ipTypePreference NOT NULL DEFAULT 'cgnat',
 *   - backfillea 'public' SOLO para filas cuya remoteAddress cae en un pool ipKind='public'
 *     cargado, de forma idempotente (guard sobre el valor actual),
 *   - NO toca el FK (ON DELETE RESTRICT preservado vía schema) ni dropea nada,
 *   - no contiene BEGIN/COMMIT (Prisma envuelve en su propia transacción).
 *
 * Mirrors migration.pppoe_nas_move_event.test.ts.
 * NAME RULE: 'pppoe_preprovision' no colisiona con ningún filtro de otros snapshot tests.
 */
import * as fs from 'fs';
import * as path from 'path';

describe('Migration: pppoe_preprovision', () => {
  let migrationSql: string;
  let dirName: string;

  beforeAll(() => {
    const migrationsDir = path.resolve(__dirname, '../../../prisma/migrations');
    const dirs = fs.readdirSync(migrationsDir).filter(d => d.endsWith('_pppoe_preprovision'));
    expect(dirs.length).toBe(1);
    dirName = dirs[0]!;
    const migrationFile = path.join(migrationsDir, dirs[0]!, 'migration.sql');
    expect(fs.existsSync(migrationFile)).toBe(true);
    migrationSql = fs.readFileSync(migrationFile, 'utf-8');
  });

  it('timestamp POSTERIOR a la última migración previa (20260825... pppoe_auto_move_flag)', () => {
    expect(dirName.slice(0, 14) > '20260825000000').toBe(true);
  });

  it('nasId pasa a NULLABLE (DROP NOT NULL) — pre-provisión = nasId NULL', () => {
    expect(migrationSql).toMatch(/ALTER COLUMN "nasId" DROP NOT NULL/);
  });

  it("agrega ipTypePreference TEXT NOT NULL DEFAULT 'cgnat'", () => {
    expect(migrationSql).toMatch(/ADD COLUMN\s+"ipTypePreference" TEXT NOT NULL DEFAULT 'cgnat'/);
  });

  it("backfill: UPDATE a 'public' cruzando contra IpPool con ipKind='public' por rango", () => {
    expect(migrationSql).toMatch(/UPDATE "PppoeService"/);
    expect(migrationSql).toMatch(/SET "ipTypePreference" = 'public'/);
    expect(migrationSql).toMatch(/"ipKind" = 'public'/);
    // Cruce por RANGO del pool (rangeStart/rangeEnd), no por prefijo.
    expect(migrationSql).toMatch(/"rangeStart"/);
    expect(migrationSql).toMatch(/"rangeEnd"/);
  });

  it("backfill IDEMPOTENTE: guard sobre el valor actual (solo pisa 'cgnat', nunca un 'public' ya decidido)", () => {
    expect(migrationSql).toMatch(/"ipTypePreference" = 'cgnat'/);
  });

  it('backfill defensivo: casts ::inet SOLO detrás de un CASE con regex IPv4 (orden de evaluación garantizado)', () => {
    expect(migrationSql).toMatch(/CASE WHEN p\."remoteAddress" ~ /);
    expect(migrationSql).toMatch(/::inet/);
  });

  it('D6.9: la regex IPv4 del backfill RECHAZA octetos con cero a la izquierda (el ::inet de PG moderno los rechaza → crash del deploy)', () => {
    // Extraer la MISMA regex que ejecuta PG y evaluarla en JS (sintaxis compatible: solo
    // clases/alternancia/cuantificadores básicos). '100.064.1.1' pasaba la regex vieja
    // ([01]?[0-9][0-9]? matchea '064') y explotaba en el cast '100.064.1.1'::inet.
    const matches = [...migrationSql.matchAll(/~ '([^']+)'/g)].map(m => m[1]!);
    expect(matches.length).toBeGreaterThan(0);
    // TODAS las apariciones (remoteAddress + rangeStart + rangeEnd) usan el MISMO patrón.
    expect(new Set(matches).size).toBe(1);
    const re = new RegExp(matches[0]!);

    // IPv4 válidas y canónicas → matchean (el backfill las cruza).
    expect(re.test('100.64.1.1')).toBe(true);
    expect(re.test('0.0.0.0')).toBe(true);
    expect(re.test('9.9.9.9')).toBe(true);
    expect(re.test('255.255.255.255')).toBe(true);
    expect(re.test('190.15.242.7')).toBe(true);

    // Octetos con cero a la izquierda → NO matchean (quedan fuera del cast, best-effort).
    expect(re.test('100.064.1.1')).toBe(false);
    expect(re.test('01.2.3.4')).toBe(false);
    expect(re.test('1.2.3.004')).toBe(false);
    expect(re.test('00.0.0.0')).toBe(false);

    // Fuera de rango / basura → NO matchean (regresión).
    expect(re.test('256.1.1.1')).toBe(false);
    expect(re.test('1.2.3')).toBe(false);
    expect(re.test('not-an-ip')).toBe(false);
    expect(re.test('1.2.3.4.5')).toBe(false);
  });

  it('es ADITIVA: no dropea tablas/columnas/constraints ni altera otras tablas', () => {
    expect(migrationSql).not.toMatch(/DROP TABLE/i);
    expect(migrationSql).not.toMatch(/DROP COLUMN/i);
    expect(migrationSql).not.toMatch(/DROP CONSTRAINT/i);
    expect(migrationSql).not.toMatch(/ALTER TABLE "(?!PppoeService)/);
  });

  it('el FK PppoeService_nasId_fkey NO se toca (sigue ON DELETE RESTRICT — borrar un NAS con servicios bloqueado)', () => {
    expect(migrationSql).not.toMatch(/ADD CONSTRAINT/i);
    expect(migrationSql).not.toMatch(/ON DELETE SET NULL/i);
  });

  it('no contiene BEGIN ni COMMIT (Prisma envuelve en su propia transacción)', () => {
    expect(migrationSql).not.toMatch(/^\s*BEGIN\s*;/im);
    expect(migrationSql).not.toMatch(/^\s*COMMIT\s*;/im);
  });
});
