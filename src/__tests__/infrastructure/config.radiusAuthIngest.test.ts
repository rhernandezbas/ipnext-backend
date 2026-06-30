/**
 * config.radiusAuthIngest.intervalMs se evalúa al importar el módulo, así que cada
 * caso setea process.env y re-importa en aislamiento (mismo patrón que
 * config.grSyncEstados.test.ts). Required vars siempre presentes para que
 * validateEnv() nunca llame a process.exit. Guarda el NOMBRE de la env var
 * (RADIUS_AUTH_INGEST_INTERVAL_MS) y el cableado default/min.
 */
describe('config.radiusAuthIngest.intervalMs (RADIUS_AUTH_INGEST_INTERVAL_MS)', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      SPLYNX_API_URL: 'http://x',
      SPLYNX_API_KEY: 'k',
      SPLYNX_API_SECRET: 's',
      JWT_SECRET: 'j',
      PORT: '3000',
    };
    delete process.env.RADIUS_AUTH_INGEST_INTERVAL_MS;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('default 60000 (1 min) cuando la env está ausente', () => {
    const { config } = require('../../infrastructure/config');
    expect(config.radiusAuthIngest.intervalMs).toBe(60_000);
  });

  it('respeta el override de la env (120000 -> 120000)', () => {
    process.env.RADIUS_AUTH_INGEST_INTERVAL_MS = '120000';
    const { config } = require('../../infrastructure/config');
    expect(config.radiusAuthIngest.intervalMs).toBe(120_000);
  });

  it('clampa al mínimo de seguridad (5000 < 15000 -> 15000)', () => {
    process.env.RADIUS_AUTH_INGEST_INTERVAL_MS = '5000';
    const { config } = require('../../infrastructure/config');
    expect(config.radiusAuthIngest.intervalMs).toBe(15_000);
  });

  it('valor inválido cae al default (abc -> 60000)', () => {
    process.env.RADIUS_AUTH_INGEST_INTERVAL_MS = 'abc';
    const { config } = require('../../infrastructure/config');
    expect(config.radiusAuthIngest.intervalMs).toBe(60_000);
  });
});
