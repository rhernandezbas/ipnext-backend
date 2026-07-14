/**
 * messaging-bulk (F2, Batch 8, T8.1) — config.twilio / config.messagingBulk se
 * evalúan al importar el módulo, así que cada caso setea process.env y
 * re-importa en aislamiento (mismo patrón que config.radiusAuthIngest.test.ts).
 * Required vars siempre presentes para que validateEnv() nunca llame a
 * process.exit — opt-in, patrón chatwoot/iclass: el boot NUNCA falla por
 * TWILIO_* ausente (lección ORCHESTRATOR_BASE_URL — env faltante = 502 en
 * prod, NUNCA 500-al-bootear).
 */
describe('config.twilio / config.messagingBulk (TWILIO_*, MESSAGING_BULK_RATE_PER_SEC)', () => {
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
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_MESSAGING_SERVICE_SID;
    delete process.env.MESSAGING_BULK_RATE_PER_SEC;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('TWILIO_* ausente → el boot NO falla, config.twilio.* cae a strings vacíos', () => {
    const { config } = require('../../infrastructure/config');
    expect(config.twilio.accountSid).toBe('');
    expect(config.twilio.authToken).toBe('');
    expect(config.twilio.messagingServiceSid).toBe('');
  });

  it('TWILIO_* presente → config.twilio.* refleja las env vars', () => {
    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN = 'tokentest';
    process.env.TWILIO_MESSAGING_SERVICE_SID = 'MGtest';
    const { config } = require('../../infrastructure/config');
    expect(config.twilio.accountSid).toBe('ACtest');
    expect(config.twilio.authToken).toBe('tokentest');
    expect(config.twilio.messagingServiceSid).toBe('MGtest');
  });

  it('MESSAGING_BULK_RATE_PER_SEC ausente → default 80', () => {
    const { config } = require('../../infrastructure/config');
    expect(config.messagingBulk.ratePerSec).toBe(80);
  });

  it('MESSAGING_BULK_RATE_PER_SEC respeta el override (120 -> 120)', () => {
    process.env.MESSAGING_BULK_RATE_PER_SEC = '120';
    const { config } = require('../../infrastructure/config');
    expect(config.messagingBulk.ratePerSec).toBe(120);
  });

  it('MESSAGING_BULK_RATE_PER_SEC inválido/<=0 → cae al default 80 (nunca 0 = "nunca envía")', () => {
    process.env.MESSAGING_BULK_RATE_PER_SEC = '-5';
    const { config } = require('../../infrastructure/config');
    expect(config.messagingBulk.ratePerSec).toBe(80);
  });
});
