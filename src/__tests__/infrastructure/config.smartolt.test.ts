/**
 * smartolt-provision (K2) — config.smartolt se evalúa al importar el módulo,
 * así que cada caso setea process.env y re-importa en aislamiento (mismo patrón
 * que config.messagingBulk.test.ts). Opt-in patrón ORCHESTRATOR_*: envs ausentes
 * → strings vacíos → feature apagada; el boot NUNCA falla por SMARTOLT_* faltante.
 */
describe('config.smartolt (SMARTOLT_BASE_URL / SMARTOLT_API_TOKEN / SMARTOLT_STEP_PAUSE_MS)', () => {
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
    delete process.env.SMARTOLT_BASE_URL;
    delete process.env.SMARTOLT_API_TOKEN;
    delete process.env.SMARTOLT_STEP_PAUSE_MS;
    delete process.env.SMARTOLT_TIMEOUT_MS;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('SMARTOLT_* ausente → el boot NO falla, baseUrl/token caen a strings vacíos (feature apagada)', () => {
    const { config } = require('../../infrastructure/config');
    expect(config.smartolt.baseUrl).toBe('');
    expect(config.smartolt.token).toBe('');
  });

  it('SMARTOLT_* presente → config.smartolt.* refleja las env vars', () => {
    process.env.SMARTOLT_BASE_URL = 'https://ipnext.smartolt.example/api';
    process.env.SMARTOLT_API_TOKEN = 'tok';
    const { config } = require('../../infrastructure/config');
    expect(config.smartolt.baseUrl).toBe('https://ipnext.smartolt.example/api');
    expect(config.smartolt.token).toBe('tok');
  });

  it('SMARTOLT_STEP_PAUSE_MS ausente → default 2000; override válido respeta', () => {
    const first = require('../../infrastructure/config');
    expect(first.config.smartolt.stepPauseMs).toBe(2000);

    jest.resetModules();
    process.env.SMARTOLT_STEP_PAUSE_MS = '500';
    const second = require('../../infrastructure/config');
    expect(second.config.smartolt.stepPauseMs).toBe(500);
  });

  it('SMARTOLT_STEP_PAUSE_MS inválido/<=0 → cae al default 2000 (fat-finger no anula la pausa)', () => {
    process.env.SMARTOLT_STEP_PAUSE_MS = '-1';
    const { config } = require('../../infrastructure/config');
    expect(config.smartolt.stepPauseMs).toBe(2000);
  });

  it('SMARTOLT_TIMEOUT_MS ausente → default 15000', () => {
    const { config } = require('../../infrastructure/config');
    expect(config.smartolt.timeoutMs).toBe(15000);
  });
});
