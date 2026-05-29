/**
 * config.gestionReal.estados is evaluated at module import time, so each case
 * sets process.env and re-imports the module in isolation. Required vars are
 * always present so validateEnv() never calls process.exit.
 */
describe('config.gestionReal.estados (GR_SYNC_ESTADOS)', () => {
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
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('defaults to the full universe [1,2,3,4,6] when GR_SYNC_ESTADOS is unset', () => {
    delete process.env.GR_SYNC_ESTADOS;
    const { config } = require('../../infrastructure/config');
    expect(config.gestionReal.estados).toEqual(['1', '2', '3', '4', '6']);
  });

  it('lets the env override win (GR_SYNC_ESTADOS=1,2 -> [1,2])', () => {
    process.env.GR_SYNC_ESTADOS = '1,2';
    const { config } = require('../../infrastructure/config');
    expect(config.gestionReal.estados).toEqual(['1', '2']);
  });

  it('falls back to the default when GR_SYNC_ESTADOS is an empty string', () => {
    process.env.GR_SYNC_ESTADOS = '';
    const { config } = require('../../infrastructure/config');
    expect(config.gestionReal.estados).toEqual(['1', '2', '3', '4', '6']);
  });
});
