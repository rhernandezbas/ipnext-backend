/**
 * radius-auto-cure-composition.test.ts — assertion estática sobre bootstrapRadiusAutoCure.ts,
 * main.ts y app.ts (radius-session-autocure BE-1, REQ-CURE-7, S7.2).
 *
 * Propósito: pinear el wiring del watcher + las rutas para que cualquier reorganización que
 * saque el bootstrap, olvide inyectar el tuning de `config.radiusAutoCure`, o desconecte la
 * ruta manual/lectura sea detectada inmediatamente. Anti-"feature muerta" (lección D-W2.5 de
 * pppoe-move-nas: sin la inyección de tuning, las envs RADIUS_AUTO_CURE_* quedan MUERTAS —
 * el use case usaría defaults internos inexistentes y el operador no podría calibrar sin
 * redeploy).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('radius-auto-cure composition root (radius-session-autocure BE-1)', () => {
  let bootstrapSrc: string;
  let mainSrc: string;
  let appSrc: string;

  beforeAll(() => {
    bootstrapSrc = readFileSync(join(__dirname, '..', '..', 'infrastructure', 'scheduling', 'bootstrapRadiusAutoCure.ts'), 'utf8');
    mainSrc      = readFileSync(join(__dirname, '..', '..', 'main.ts'), 'utf8');
    appSrc       = readFileSync(join(__dirname, '..', '..', 'infrastructure', 'http', 'app.ts'), 'utf8');
  });

  it('S7.1: bootstrapRadiusAutoCure retorna null sin ORCHESTRATOR_BASE_URL (opt-in)', () => {
    expect(bootstrapSrc).toMatch(/if\s*\(\s*!baseUrl\s*\)/);
    expect(bootstrapSrc).toMatch(/return null/);
  });

  it('S7.2: el bootstrap inyecta CADA campo del tuning desde config.radiusAutoCure (sin esto, las envs quedan muertas)', () => {
    for (const field of ['staleMs', 'persistenceMs', 'recencyMs', 'lookbackMs', 'abortThreshold', 'maxPerTick', 'cooldownMs', 'flappingMax']) {
      expect(bootstrapSrc).toMatch(new RegExp(`config\\.radiusAutoCure\\.${field}`));
    }
  });

  it('el bootstrap usa PgAdvisoryLock + PrismaFeatureFlagRepository (mismo molde pppoe-auto-move)', () => {
    expect(bootstrapSrc).toMatch(/new PgAdvisoryLock\(\)/);
    expect(bootstrapSrc).toMatch(/new PrismaFeatureFlagRepository\(\)/);
  });

  it('main.ts importa y arranca bootstrapRadiusAutoCure (scheduler.start())', () => {
    expect(mainSrc).toMatch(/import.*bootstrapRadiusAutoCure.*from.*bootstrapRadiusAutoCure/);
    const idx = mainSrc.indexOf('bootstrapRadiusAutoCure()');
    expect(idx).toBeGreaterThan(-1);
    const window = mainSrc.slice(idx, idx + 200);
    expect(window).toMatch(/scheduler\?\.start\(\)/);
  });

  it('app.ts wirea listRadiusSessionCures y cureStuckSession en createRadiusRouter', () => {
    const idx = appSrc.indexOf('createRadiusRouter(');
    expect(idx).toBeGreaterThan(-1);
    const window = appSrc.slice(idx, idx + 400);
    expect(window).toMatch(/listRadiusSessionCures/);
    expect(window).toMatch(/cureStuckSession/);
  });

  it('app.ts instancia PrismaRadiusSessionCureEventRepository', () => {
    expect(appSrc).toMatch(/new PrismaRadiusSessionCureEventRepository\(\)/);
  });

  it('cureStuckSession en app.ts recibe el tuning de config.radiusAutoCure (staleMs/persistenceMs/recencyMs)', () => {
    const idx = appSrc.indexOf('new CureStuckSession(');
    expect(idx).toBeGreaterThan(-1);
    const window = appSrc.slice(idx, idx + 300);
    expect(window).toMatch(/config\.radiusAutoCure\.staleMs/);
    expect(window).toMatch(/config\.radiusAutoCure\.persistenceMs/);
    expect(window).toMatch(/config\.radiusAutoCure\.recencyMs/);
  });
});
