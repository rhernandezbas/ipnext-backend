/**
 * config.radiusAutoCure — se evalúa al importar el módulo, así que cada caso setea process.env
 * y re-importa en aislamiento (mismo patrón que config.radiusAuthIngest.test.ts). Cubre S2.7
 * (piso duro staleMs 20min / piso persistenceMs 2min), S7.3 (envs documentadas — ver env.example)
 * y S7.4 (coherencia LOOKBACK_MS > PERSISTENCE_MS + RECENCY_MS, clamp hacia arriba con WARN).
 */
describe('config.radiusAutoCure', () => {
  const ORIGINAL_ENV = process.env;
  const VARS = [
    'RADIUS_AUTO_CURE_INTERVAL_MS',
    'RADIUS_AUTO_CURE_LOOKBACK_MS',
    'RADIUS_AUTO_CURE_STALE_MS',
    'RADIUS_AUTO_CURE_PERSISTENCE_MS',
    'RADIUS_AUTO_CURE_REJECT_RECENCY_MS',
    'RADIUS_AUTO_CURE_MAX_PER_TICK',
    'RADIUS_AUTO_CURE_ABORT_THRESHOLD',
    'RADIUS_AUTO_CURE_COOLDOWN_MS',
    'RADIUS_AUTO_CURE_FLAPPING_MAX',
  ];

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      SPLYNX_API_URL: 'http://x', SPLYNX_API_KEY: 'k', SPLYNX_API_SECRET: 's',
      JWT_SECRET: 'j', PORT: '3000',
    };
    for (const v of VARS) delete process.env[v];
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('defaults: interval 60s, lookback 15min, stale 20min, persistence 5min, recency 2min, maxPerTick 5, abortThreshold 20, cooldown 30min, flappingMax 3', () => {
    const { config } = require('../../infrastructure/config');
    expect(config.radiusAutoCure.intervalMs).toBe(60_000);
    expect(config.radiusAutoCure.lookbackMs).toBe(900_000);
    expect(config.radiusAutoCure.staleMs).toBe(1_200_000);
    expect(config.radiusAutoCure.persistenceMs).toBe(300_000);
    expect(config.radiusAutoCure.recencyMs).toBe(120_000);
    expect(config.radiusAutoCure.maxPerTick).toBe(5);
    expect(config.radiusAutoCure.abortThreshold).toBe(20);
    expect(config.radiusAutoCure.cooldownMs).toBe(1_800_000);
    expect(config.radiusAutoCure.flappingMax).toBe(3);
  });

  it('S2.7: RADIUS_AUTO_CURE_STALE_MS=60000 (bajo el piso) → clampa a 20min (piso DURO)', () => {
    process.env.RADIUS_AUTO_CURE_STALE_MS = '60000';
    const { config } = require('../../infrastructure/config');
    expect(config.radiusAutoCure.staleMs).toBe(1_200_000);
  });

  it('S2.7: RADIUS_AUTO_CURE_PERSISTENCE_MS bajo 2min → clampa a 2min (piso)', () => {
    process.env.RADIUS_AUTO_CURE_PERSISTENCE_MS = '30000'; // 30s
    const { config } = require('../../infrastructure/config');
    expect(config.radiusAutoCure.persistenceMs).toBe(120_000);
  });

  it('RADIUS_AUTO_CURE_REJECT_RECENCY_MS bajo 30s → clampa a 30s (piso)', () => {
    process.env.RADIUS_AUTO_CURE_REJECT_RECENCY_MS = '5000';
    const { config } = require('../../infrastructure/config');
    expect(config.radiusAutoCure.recencyMs).toBe(30_000);
  });

  it('respeta overrides válidos dentro de rango', () => {
    process.env.RADIUS_AUTO_CURE_MAX_PER_TICK = '10';
    process.env.RADIUS_AUTO_CURE_ABORT_THRESHOLD = '30';
    process.env.RADIUS_AUTO_CURE_FLAPPING_MAX = '5';
    const { config } = require('../../infrastructure/config');
    expect(config.radiusAutoCure.maxPerTick).toBe(10);
    expect(config.radiusAutoCure.abortThreshold).toBe(30);
    expect(config.radiusAutoCure.flappingMax).toBe(5);
  });

  it('valores inválidos caen al default (boot OK, nunca revienta)', () => {
    process.env.RADIUS_AUTO_CURE_MAX_PER_TICK = 'abc';
    process.env.RADIUS_AUTO_CURE_COOLDOWN_MS = 'not-a-number';
    const { config } = require('../../infrastructure/config');
    expect(config.radiusAutoCure.maxPerTick).toBe(5);
    expect(config.radiusAutoCure.cooldownMs).toBe(1_800_000);
  });

  it('S7.4: LOOKBACK_MS <= PERSISTENCE_MS + RECENCY_MS → clampa el lookback hacia arriba (boot OK)', () => {
    process.env.RADIUS_AUTO_CURE_LOOKBACK_MS = '60000'; // 1min — menor que persistence(5min)+recency(2min)=7min
    const { config } = require('../../infrastructure/config');
    expect(config.radiusAutoCure.lookbackMs).toBeGreaterThan(
      config.radiusAutoCure.persistenceMs + config.radiusAutoCure.recencyMs,
    );
  });

  it('coherencia respeta un lookback ya válido sin tocarlo', () => {
    process.env.RADIUS_AUTO_CURE_LOOKBACK_MS = '900000'; // 15min > 5+2
    const { config } = require('../../infrastructure/config');
    expect(config.radiusAutoCure.lookbackMs).toBe(900_000);
  });
});
