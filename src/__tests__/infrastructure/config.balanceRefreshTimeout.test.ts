/**
 * customer-balance-unmask (Fase 4, tarea 4.14/4.15) — design.md Decisión 4: el
 * techo de `BALANCE_REFRESH_TIMEOUT_MS` baja de 60.000ms a 10.000ms. Un env de
 * 60s corriendo DENTRO del flujo de un mensaje de WhatsApp (el bot es el primer
 * consumidor que paga ese timeout en el camino caliente) es un cuelgue — lección
 * de la fix wave del portal ("techo del timeout de refresh 10s y no 60"). El
 * default (4000ms) NO cambia — solo el piso de seguridad del clamp.
 *
 * Mismo patrón de aislamiento que config.messagingBulk.test.ts: `config.ts`
 * corre `validateEnv()` como side-effect de import, así que cada caso setea
 * `process.env` y re-importa con `jest.resetModules()`.
 */
describe('config.gestionReal.balanceRefreshTimeoutMs (BALANCE_REFRESH_TIMEOUT_MS)', () => {
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
    delete process.env.BALANCE_REFRESH_TIMEOUT_MS;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('ausente → default 4000 (sin cambio)', () => {
    const { config } = require('../../infrastructure/config');
    expect(config.gestionReal.balanceRefreshTimeoutMs).toBe(4000);
  });

  it('BALANCE_REFRESH_TIMEOUT_MS=60000 clampea al NUEVO techo 10000 (antes: 60000 pasaba tal cual)', () => {
    process.env.BALANCE_REFRESH_TIMEOUT_MS = '60000';
    const { config } = require('../../infrastructure/config');
    expect(config.gestionReal.balanceRefreshTimeoutMs).toBe(10000);
  });

  it('BALANCE_REFRESH_TIMEOUT_MS=8000 (dentro del nuevo techo) pasa sin clampear', () => {
    process.env.BALANCE_REFRESH_TIMEOUT_MS = '8000';
    const { config } = require('../../infrastructure/config');
    expect(config.gestionReal.balanceRefreshTimeoutMs).toBe(8000);
  });
});
