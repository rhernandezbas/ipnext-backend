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
});
