/**
 * fiber-watcher-composition.test.ts — assertion estática sobre el composition root del
 * watcher K3 (convención radius-auto-cure-composition / fiber-composition M4).
 *
 * Propósito: pinear el wiring REAL para que cualquier reorganización que desmonte el
 * scheduler, olvide el tuning de config, o rompa el seed del flag sea detectada de
 * inmediato (anti-"feature muerta", lección W6 de pppoe-move-nas).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const INFRA = join(__dirname, '..', '..', 'infrastructure');

describe('fiber-auto-watcher composition root (K3)', () => {
  let mainSrc: string;
  let bootstrapSrc: string;
  let schedulerSrc: string;
  let configSrc: string;
  let migrationSql: string;

  beforeAll(() => {
    mainSrc = readFileSync(join(__dirname, '..', '..', 'main.ts'), 'utf8');
    bootstrapSrc = readFileSync(join(INFRA, 'scheduling', 'bootstrapAutoProvisionFiber.ts'), 'utf8');
    schedulerSrc = readFileSync(join(INFRA, 'scheduling', 'AutoProvisionFiberScheduler.ts'), 'utf8');
    configSrc = readFileSync(join(INFRA, 'config.ts'), 'utf8');
    migrationSql = readFileSync(
      join(__dirname, '..', '..', '..', 'prisma', 'migrations', '20260924000000_fiber_auto_watcher', 'migration.sql'),
      'utf8',
    );
  });

  it('main.ts importa y arranca bootstrapAutoProvisionFiber (scheduler.start())', () => {
    expect(mainSrc).toMatch(/import.*bootstrapAutoProvisionFiber.*from.*bootstrapAutoProvisionFiber/);
    const idx = mainSrc.indexOf('bootstrapAutoProvisionFiber()');
    expect(idx).toBeGreaterThan(-1);
    const window = mainSrc.slice(idx, idx + 200);
    expect(window).toMatch(/\.start\(\)/);
  });

  it('bootstrap: sin SMARTOLT_BASE_URL/SMARTOLT_API_TOKEN retorna null (opt-in, skip silencioso)', () => {
    expect(bootstrapSrc).toMatch(/config\.smartolt/);
    expect(bootstrapSrc).toMatch(/baseUrl/);
    expect(bootstrapSrc).toMatch(/token/);
    expect(bootstrapSrc).toMatch(/return null/);
  });

  it('bootstrap: inyecta el tuning de config (interval del watcher + tuning SmartOLT) — sin esto las envs quedan muertas', () => {
    expect(bootstrapSrc).toMatch(/config\.fiberAutoProvision\.intervalMs/);
    for (const field of ['timeoutMs', 'stepPauseMs']) {
      expect(bootstrapSrc).toMatch(new RegExp(`config\\.smartolt\\.${field}`));
    }
  });

  it('bootstrap: lock cross-replica (PgAdvisoryLock) + flag repo Prisma, chequeados POR TICK en el scheduler', () => {
    expect(bootstrapSrc).toMatch(/new PgAdvisoryLock\(\)/);
    expect(bootstrapSrc).toMatch(/new PrismaFeatureFlagRepository\(\)/);
  });

  it("scheduler: flag y lock keys = 'fiber-auto-provision-watcher' (SEPARADO del flag del wizard)", () => {
    expect(schedulerSrc).toMatch(/FLAG_KEY = 'fiber-auto-provision-watcher'/);
    expect(schedulerSrc).toMatch(/LOCK_KEY = 'fiber-auto-provision-watcher'/);
    // Jamás gateado por el flag del wizard (las CONSTANTES, no los comentarios).
    expect(schedulerSrc).not.toMatch(/(?:FLAG_KEY|LOCK_KEY) = 'fiber-auto-provision'/);
  });

  it('config: FIBER_AUTO_PROVISION_INTERVAL_MS con default 5min / piso 60s / techo 24h', () => {
    const idx = configSrc.indexOf('fiberAutoProvision');
    expect(idx).toBeGreaterThan(-1);
    const window = configSrc.slice(idx, idx + 400);
    expect(window).toMatch(/FIBER_AUTO_PROVISION_INTERVAL_MS/);
    expect(window).toMatch(/default: 300_000/);
    expect(window).toMatch(/min: 60_000/);
    expect(window).toMatch(/max: 86_400_000/);
  });

  it('la migración es ADITIVA e idempotente: columna onuSerial + tabla de intentos + flag seed OFF', () => {
    expect(migrationSql).toMatch(/ALTER TABLE "ScheduledTask" ADD COLUMN IF NOT EXISTS "onuSerial" TEXT/);
    expect(migrationSql).toMatch(/CREATE TABLE IF NOT EXISTS "FiberAutoProvisionAttempt"/);
    // Unique por (taskId, onuSn): una fila de intentos por par tarea↔ONU.
    expect(migrationSql).toMatch(/"FiberAutoProvisionAttempt_taskId_onuSn_key"/);
    // Flag NUEVO seed OFF (el PATCH de flags usa update, no upsert — sin seed no hay toggle).
    expect(migrationSql).toMatch(/'fiber-auto-provision-watcher',\s*false/);
    expect(migrationSql).toMatch(/ON CONFLICT DO NOTHING/);
  });
});
