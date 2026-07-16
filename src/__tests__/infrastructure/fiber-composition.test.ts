/**
 * fiber-composition.test.ts — assertion estática sobre app.ts + la migración
 * (smartolt-provision K2, fix wave M4 — convención radius-auto-cure-composition).
 *
 * Propósito: pinear el wiring REAL de /api/fiber para que cualquier
 * reorganización que desmonte el router, olvide inyectar el tuning de
 * config.smartolt, o rompa el seed del flag sea detectada de inmediato.
 * Anti-"feature muerta" (lección W6 de pppoe-move-nas: una ruta sin wiring
 * compila perfecto y la feature queda muerta en silencio).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('fiber composition root (smartolt-provision K2)', () => {
  let appSrc: string;
  let migrationSql: string;

  beforeAll(() => {
    appSrc = readFileSync(
      join(__dirname, '..', '..', 'infrastructure', 'http', 'app.ts'),
      'utf8',
    );
    migrationSql = readFileSync(
      join(__dirname, '..', '..', '..', 'prisma', 'migrations', '20260923000000_smartolt_provision', 'migration.sql'),
      'utf8',
    );
  });

  it('app.ts monta createFiberRouter en /api/fiber', () => {
    const idx = appSrc.indexOf("app.use('/api/fiber', createFiberRouter(");
    expect(idx).toBeGreaterThan(-1);
  });

  it('el router recibe featureFlagRepo + smartoltConfigured + los CUATRO use cases', () => {
    const idx = appSrc.indexOf("app.use('/api/fiber', createFiberRouter(");
    const window = appSrc.slice(idx, idx + 700);
    expect(window).toMatch(/featureFlagRepo/);
    expect(window).toMatch(/smartoltConfigured/);
    expect(window).toMatch(/new ListUnconfiguredOnus\(/);
    expect(window).toMatch(/provisionFiberOnu/);
    expect(window).toMatch(/new ListSmartOltOlts\(/);
    expect(window).toMatch(/new UpdateSmartOltOlt\(/);
  });

  it('smartoltConfigured deriva de config.smartolt.baseUrl + token (opt-in, sin fail-fast)', () => {
    const idx = appSrc.indexOf('const smartoltConfigured');
    expect(idx).toBeGreaterThan(-1);
    const window = appSrc.slice(idx, idx + 200);
    expect(window).toMatch(/config\.smartolt\.baseUrl/);
    expect(window).toMatch(/config\.smartolt\.token/);
  });

  it('SmartOltHttpGateway recibe el tuning completo de config.smartolt (sin esto, las envs quedan muertas)', () => {
    const idx = appSrc.indexOf('new SmartOltHttpGateway({');
    expect(idx).toBeGreaterThan(-1);
    const window = appSrc.slice(idx, idx + 300);
    for (const field of ['baseUrl', 'token', 'timeoutMs', 'stepPauseMs']) {
      expect(window).toMatch(new RegExp(`config\\.smartolt\\.${field}`));
    }
  });

  it('ProvisionFiberOnu se compone con el pregen K1 + lookup de contrato + task writer Prisma', () => {
    expect(appSrc).toMatch(/new PrismaSmartOltOltConfigRepository\(\)/);
    const idx = appSrc.indexOf('new ProvisionFiberOnu(');
    expect(idx).toBeGreaterThan(-1);
    const window = appSrc.slice(idx, idx + 500);
    expect(window).toMatch(/pregenForFiber/);
    expect(window).toMatch(/prismaFiberContractLookup/);
    expect(window).toMatch(/prismaFiberInstallTaskWriter/);
    expect(window).toMatch(/new PrismaGestionRealIngestConfigRepository\(\)/);
  });

  it('la migración crea la tabla, seedea las 4 OLTs y el flag fiber-auto-provision OFF — todo idempotente', () => {
    expect(migrationSql).toMatch(/CREATE TABLE IF NOT EXISTS "SmartOltOltConfig"/);
    // Las 4 OLTs empíricas (el PATCH de flags usa update, no upsert — sin seed no hay toggle).
    for (const oltId of ["'1'", "'3'", "'5'", "'7'"]) {
      expect(migrationSql).toContain(oltId);
    }
    expect(migrationSql).toMatch(/'fiber-auto-provision',\s*false/);
    const conflictCount = migrationSql.match(/ON CONFLICT/g) ?? [];
    expect(conflictCount.length).toBeGreaterThanOrEqual(2); // seed OLTs + seed flag
  });
});
