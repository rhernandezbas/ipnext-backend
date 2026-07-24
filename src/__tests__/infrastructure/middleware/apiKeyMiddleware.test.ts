import { Request, Response, NextFunction } from 'express';
import { createApiKeyMiddleware } from '../../../infrastructure/http/middleware/apiKeyMiddleware';
import { config } from '../../../infrastructure/config';

// We'll override config.externalApi.apiKey per test
jest.mock('../../../infrastructure/config', () => ({
  config: {
    externalApi: { apiKey: '' },
  },
}));

const mockConfig = config as { externalApi: { apiKey: string } };

function makeReq(headers: Record<string, string> = {}): Request {
  return { headers } as unknown as Request;
}

function makeRes(): { status: jest.Mock; json: jest.Mock } {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

describe('createApiKeyMiddleware', () => {
  let next: NextFunction;

  beforeEach(() => {
    next = jest.fn();
    jest.clearAllMocks();
  });

  describe('no key configured (apiKey is empty)', () => {
    beforeEach(() => {
      mockConfig.externalApi.apiKey = '';
    });

    it('returns 401 even when a key is provided in X-API-Key', () => {
      const mw = createApiKeyMiddleware();
      const req = makeReq({ 'x-api-key': 'some-key' });
      const res = makeRes() as unknown as Response;

      mw(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid or missing API key', code: 'UNAUTHORIZED' });
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 401 when no key is provided at all', () => {
      const mw = createApiKeyMiddleware();
      const req = makeReq({});
      const res = makeRes() as unknown as Response;

      mw(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('key is configured', () => {
    const CONFIGURED_KEY = 'test-api-key-abc123';

    beforeEach(() => {
      mockConfig.externalApi.apiKey = CONFIGURED_KEY;
    });

    it('returns 401 when no key header is present', () => {
      const mw = createApiKeyMiddleware();
      const req = makeReq({});
      const res = makeRes() as unknown as Response;

      mw(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid or missing API key', code: 'UNAUTHORIZED' });
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 401 when X-API-Key is wrong', () => {
      const mw = createApiKeyMiddleware();
      const req = makeReq({ 'x-api-key': 'wrong-key' });
      const res = makeRes() as unknown as Response;

      mw(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 401 when Authorization Bearer has wrong key', () => {
      const mw = createApiKeyMiddleware();
      const req = makeReq({ authorization: 'Bearer wrong-key' });
      const res = makeRes() as unknown as Response;

      mw(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('calls next() when X-API-Key is correct', () => {
      const mw = createApiKeyMiddleware();
      const req = makeReq({ 'x-api-key': CONFIGURED_KEY });
      const res = makeRes() as unknown as Response;

      mw(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('calls next() when Authorization: Bearer <key> is correct', () => {
      const mw = createApiKeyMiddleware();
      const req = makeReq({ authorization: `Bearer ${CONFIGURED_KEY}` });
      const res = makeRes() as unknown as Response;

      mw(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('returns 401 for Authorization without Bearer prefix', () => {
      const mw = createApiKeyMiddleware();
      const req = makeReq({ authorization: CONFIGURED_KEY });
      const res = makeRes() as unknown as Response;

      mw(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });
  });

  // A18 — factory parametrizada por key explícita (source-specific: grafanaIngestKey
  // / fiberIngestKey), SIN romper /api/external/v1 (`createApiKeyMiddleware()` sin
  // args sigue leyendo config.externalApi.apiKey — ver describe blocks arriba).
  describe('explicit configuredKey param (per-source key, A18)', () => {
    it('usa la key EXPLÍCITA, ignorando config.externalApi.apiKey', () => {
      mockConfig.externalApi.apiKey = 'unrelated-external-api-key';
      const mw = createApiKeyMiddleware('grafana-explicit-key');
      const req = makeReq({ 'x-api-key': 'grafana-explicit-key' });
      const res = makeRes() as unknown as Response;

      mw(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('rechaza la key de OTRA fuente aunque sea válida para config.externalApi.apiKey', () => {
      const EXTERNAL_KEY = 'unrelated-external-api-key';
      mockConfig.externalApi.apiKey = EXTERNAL_KEY;
      const mw = createApiKeyMiddleware('grafana-explicit-key');
      const req = makeReq({ 'x-api-key': EXTERNAL_KEY });
      const res = makeRes() as unknown as Response;

      mw(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('key explícita vacía → fail-closed (401) sin importar el header', () => {
      const mw = createApiKeyMiddleware('');
      const req = makeReq({ 'x-api-key': 'anything' });
      const res = makeRes() as unknown as Response;

      mw(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });
  });

  // F7 (fix wave, noc-alerts-hub) — comparación constant-time (crypto.timingSafeEqual)
  // en vez de `!==`. Estos tests son de COMPORTAMIENTO (no de implementación): deben
  // seguir rechazando/aceptando exactamente igual que antes, timing aparte.
  describe('constant-time comparison (F7)', () => {
    const CONFIGURED_KEY = 'test-api-key-abc123';

    beforeEach(() => {
      mockConfig.externalApi.apiKey = CONFIGURED_KEY;
    });

    it('rechaza una key del MISMO largo que difiere en un solo carácter', () => {
      const sameLengthWrongKey = 'test-api-key-abc124'; // difiere en el último char
      expect(sameLengthWrongKey.length).toBe(CONFIGURED_KEY.length);
      const mw = createApiKeyMiddleware();
      const req = makeReq({ 'x-api-key': sameLengthWrongKey });
      const res = makeRes() as unknown as Response;

      mw(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('rechaza una key MÁS CORTA que la configurada (no debe tirar por buffers de largo distinto)', () => {
      const mw = createApiKeyMiddleware();
      const req = makeReq({ 'x-api-key': 'short' });
      const res = makeRes() as unknown as Response;

      expect(() => mw(req, res, next)).not.toThrow();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('rechaza una key MÁS LARGA que la configurada', () => {
      const mw = createApiKeyMiddleware();
      const req = makeReq({ 'x-api-key': `${CONFIGURED_KEY}-extra-suffix` });
      const res = makeRes() as unknown as Response;

      mw(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('sigue aceptando la key exacta', () => {
      const mw = createApiKeyMiddleware();
      const req = makeReq({ 'x-api-key': CONFIGURED_KEY });
      const res = makeRes() as unknown as Response;

      mw(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });
  });
});
