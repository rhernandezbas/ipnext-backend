/**
 * Migration SQL-text snapshot test — install-pppoe-pregen (K1).
 * Verifica que la migración ADITIVA:
 *   - agrega GestionRealIngestConfig.pppoeProfile como TEXT NULLABLE (grupo RADIUS
 *     para la pre-provisión; null = sin configurar → pre-generación degrada a no-op),
 *   - siembra el feature flag 'install-pppoe-pregen' DEFAULT OFF de forma idempotente
 *     (INSERT ... ON CONFLICT DO NOTHING — el PATCH de flags usa update, no upsert:
 *     sin seed el flag no existe y el operador no puede prenderlo),
 *   - NO dropea nada ni toca otras tablas,
 *   - no contiene BEGIN/COMMIT (Prisma envuelve en su propia transacción).
 *
 * Mirrors migration.pppoe_preprovision.test.ts / el patrón de seeds de flags
 * (20260917000100_radius_auto_cure_flag).
 * NAME RULE: 'install_pppoe_pregen' no colisiona con ningún filtro de otros snapshot tests.
 */
import * as fs from 'fs';
import * as path from 'path';

describe('Migration: install_pppoe_pregen', () => {
  let migrationSql: string;
  let dirName: string;

  beforeAll(() => {
    const migrationsDir = path.resolve(__dirname, '../../../prisma/migrations');
    const dirs = fs.readdirSync(migrationsDir).filter(d => d.endsWith('_install_pppoe_pregen'));
    expect(dirs.length).toBe(1);
    dirName = dirs[0]!;
    const migrationFile = path.join(migrationsDir, dirs[0]!, 'migration.sql');
    expect(fs.existsSync(migrationFile)).toBe(true);
    migrationSql = fs.readFileSync(migrationFile, 'utf-8');
  });

  it('timestamp POSTERIOR a la última migración previa (20260921... chatmessage_idempotency_key)', () => {
    expect(dirName.slice(0, 14) > '20260921000000').toBe(true);
  });

  it('agrega GestionRealIngestConfig.pppoeProfile como TEXT NULLABLE (sin NOT NULL, sin default)', () => {
    expect(migrationSql).toMatch(
      /ALTER TABLE "GestionRealIngestConfig" ADD COLUMN\s+"pppoeProfile" TEXT;/,
    );
    // Nullable a propósito: null = sin configurar. Un NOT NULL acá rompería el deploy.
    expect(migrationSql).not.toMatch(/"pppoeProfile" TEXT NOT NULL/);
  });

  it("siembra el flag 'install-pppoe-pregen' en FALSE (default OFF — rollout oscuro)", () => {
    expect(migrationSql).toMatch(/INSERT INTO "FeatureFlag"/);
    expect(migrationSql).toMatch(/'install-pppoe-pregen', false/);
  });

  it('el seed del flag es IDEMPOTENTE: ON CONFLICT DO NOTHING (re-deploy seguro)', () => {
    expect(migrationSql).toMatch(/ON CONFLICT DO NOTHING/);
  });

  it('es ADITIVA: no dropea tablas/columnas/constraints ni altera otras tablas', () => {
    expect(migrationSql).not.toMatch(/DROP TABLE/i);
    expect(migrationSql).not.toMatch(/DROP COLUMN/i);
    expect(migrationSql).not.toMatch(/DROP CONSTRAINT/i);
    expect(migrationSql).not.toMatch(/ALTER TABLE "(?!GestionRealIngestConfig)/);
    expect(migrationSql).not.toMatch(/UPDATE /);
    expect(migrationSql).not.toMatch(/DELETE /);
  });

  it('no contiene BEGIN ni COMMIT (Prisma envuelve en su propia transacción)', () => {
    expect(migrationSql).not.toMatch(/^\s*BEGIN\s*;/im);
    expect(migrationSql).not.toMatch(/^\s*COMMIT\s*;/im);
  });
});
