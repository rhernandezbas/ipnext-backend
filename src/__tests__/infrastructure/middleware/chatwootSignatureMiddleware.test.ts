import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import {
  createChatwootSignatureMiddleware,
  rawBodyJsonParser,
} from '../../../infrastructure/http/middleware/chatwootSignatureMiddleware';
import { config } from '../../../infrastructure/config';

// We'll override config.chatwoot.webhookSecret per test (same pattern as apiKeyMiddleware.test.ts).
jest.mock('../../../infrastructure/config', () => ({
  config: {
    chatwoot: { webhookSecret: '' },
  },
}));

const mockConfig = config as unknown as { chatwoot: { webhookSecret: string } };

const SECRET = 'chatwoot-webhook-secret-abc123';
const NOW_MS = 1_800_000_000_000; // fixed clock for deterministic tests
const NOW_SEC = Math.floor(NOW_MS / 1000);

function sign(secret: string, timestamp: string, rawBody: Buffer): string {
  const hex = crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
  return `sha256=${hex}`;
}

function makeReq(opts: {
  headers?: Record<string, string>;
  rawBody?: Buffer;
}): Request {
  return {
    headers: opts.headers ?? {},
    rawBody: opts.rawBody,
  } as unknown as Request;
}

function makeRes(): { status: jest.Mock; json: jest.Mock } {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

describe('createChatwootSignatureMiddleware', () => {
  let next: NextFunction;
  const body = Buffer.from(JSON.stringify({ event: 'message_created', id: 1 }));

  beforeEach(() => {
    next = jest.fn();
    jest.clearAllMocks();
    mockConfig.chatwoot.webhookSecret = SECRET;
  });

  it('esc1 (HOOK-1): firma válida y timestamp dentro de ventana -> next()', () => {
    const timestamp = String(NOW_SEC);
    const signature = sign(SECRET, timestamp, body);
    const mw = createChatwootSignatureMiddleware({ now: () => NOW_MS });
    const req = makeReq({
      headers: { 'x-chatwoot-signature': signature, 'x-chatwoot-timestamp': timestamp },
      rawBody: body,
    });
    const res = makeRes() as unknown as Response;

    mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('esc2 (HOOK-1): firma inválida -> 401 INVALID_SIGNATURE, no procesa', () => {
    const timestamp = String(NOW_SEC);
    const mw = createChatwootSignatureMiddleware({ now: () => NOW_MS });
    const req = makeReq({
      headers: {
        'x-chatwoot-signature': 'sha256=' + 'deadbeef'.repeat(8),
        'x-chatwoot-timestamp': timestamp,
      },
      rawBody: body,
    });
    const res = makeRes() as unknown as Response;

    mw(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_SIGNATURE' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('esc2 (HOOK-1): body alterado respecto al firmado -> 401 INVALID_SIGNATURE', () => {
    const timestamp = String(NOW_SEC);
    const signature = sign(SECRET, timestamp, body);
    const tamperedBody = Buffer.from(JSON.stringify({ event: 'message_created', id: 999 }));
    const mw = createChatwootSignatureMiddleware({ now: () => NOW_MS });
    const req = makeReq({
      headers: { 'x-chatwoot-signature': signature, 'x-chatwoot-timestamp': timestamp },
      rawBody: tamperedBody,
    });
    const res = makeRes() as unknown as Response;

    mw(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_SIGNATURE' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('esc2 (HOOK-1): header de firma ausente -> 401 INVALID_SIGNATURE', () => {
    const timestamp = String(NOW_SEC);
    const mw = createChatwootSignatureMiddleware({ now: () => NOW_MS });
    const req = makeReq({
      headers: { 'x-chatwoot-timestamp': timestamp },
      rawBody: body,
    });
    const res = makeRes() as unknown as Response;

    mw(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_SIGNATURE' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('esc2 (HOOK-1): header de firma malformado (sin prefijo sha256=) -> 401 INVALID_SIGNATURE', () => {
    const timestamp = String(NOW_SEC);
    const hex = crypto.createHmac('sha256', SECRET).update(`${timestamp}.`).update(body).digest('hex');
    const mw = createChatwootSignatureMiddleware({ now: () => NOW_MS });
    const req = makeReq({
      headers: { 'x-chatwoot-signature': hex, 'x-chatwoot-timestamp': timestamp }, // sin "sha256="
      rawBody: body,
    });
    const res = makeRes() as unknown as Response;

    mw(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_SIGNATURE' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('esc3 (HOOK-1): falta rawBody (parseado/mutado antes) -> fail-closed 401 INVALID_SIGNATURE', () => {
    const timestamp = String(NOW_SEC);
    // La firma es "válida" para un rawBody dado, pero req.rawBody nunca se seteó
    // (p.ej. otro parser corrió antes) — el sistema NUNCA debe asumir válido por defecto.
    const signature = sign(SECRET, timestamp, body);
    const mw = createChatwootSignatureMiddleware({ now: () => NOW_MS });
    const req = makeReq({
      headers: { 'x-chatwoot-signature': signature, 'x-chatwoot-timestamp': timestamp },
      rawBody: undefined,
    });
    const res = makeRes() as unknown as Response;

    mw(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_SIGNATURE' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('header de timestamp ausente -> 401 INVALID_SIGNATURE (no se puede recomputar el HMAC)', () => {
    const timestamp = String(NOW_SEC);
    const signature = sign(SECRET, timestamp, body);
    const mw = createChatwootSignatureMiddleware({ now: () => NOW_MS });
    const req = makeReq({
      headers: { 'x-chatwoot-signature': signature },
      rawBody: body,
    });
    const res = makeRes() as unknown as Response;

    mw(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_SIGNATURE' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('secret no configurado (vacío) -> 401 fail-closed, ni siquiera intenta comparar', () => {
    mockConfig.chatwoot.webhookSecret = '';
    const timestamp = String(NOW_SEC);
    const signature = sign('cualquier-secret', timestamp, body);
    const mw = createChatwootSignatureMiddleware({ now: () => NOW_MS });
    const req = makeReq({
      headers: { 'x-chatwoot-signature': signature, 'x-chatwoot-timestamp': timestamp },
      rawBody: body,
    });
    const res = makeRes() as unknown as Response;

    mw(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_SIGNATURE' }));
    expect(next).not.toHaveBeenCalled();
  });

  describe('HOOK-2 — ventana de replay ±5min', () => {
    it('timestamp a 30s de la hora actual -> se acepta (dentro de ventana)', () => {
      const timestamp = String(NOW_SEC - 30);
      const signature = sign(SECRET, timestamp, body);
      const mw = createChatwootSignatureMiddleware({ now: () => NOW_MS });
      const req = makeReq({
        headers: { 'x-chatwoot-signature': signature, 'x-chatwoot-timestamp': timestamp },
        rawBody: body,
      });
      const res = makeRes() as unknown as Response;

      mw(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('timestamp viejo (replay, > 5min en el pasado) -> 401 STALE_TIMESTAMP', () => {
      const timestamp = String(NOW_SEC - 6 * 60); // 6 min atrás
      const signature = sign(SECRET, timestamp, body);
      const mw = createChatwootSignatureMiddleware({ now: () => NOW_MS });
      const req = makeReq({
        headers: { 'x-chatwoot-signature': signature, 'x-chatwoot-timestamp': timestamp },
        rawBody: body,
      });
      const res = makeRes() as unknown as Response;

      mw(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'STALE_TIMESTAMP' }));
      expect(next).not.toHaveBeenCalled();
    });

    it('timestamp futuro fuera de tolerancia (> 5min adelante) -> 401 STALE_TIMESTAMP', () => {
      const timestamp = String(NOW_SEC + 6 * 60); // 6 min en el futuro
      const signature = sign(SECRET, timestamp, body);
      const mw = createChatwootSignatureMiddleware({ now: () => NOW_MS });
      const req = makeReq({
        headers: { 'x-chatwoot-signature': signature, 'x-chatwoot-timestamp': timestamp },
        rawBody: body,
      });
      const res = makeRes() as unknown as Response;

      mw(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'STALE_TIMESTAMP' }));
      expect(next).not.toHaveBeenCalled();
    });

    it('timestamp malformado (no numérico) -> 401 STALE_TIMESTAMP (no se puede validar ventana)', () => {
      const timestamp = 'not-a-number';
      const signature = sign(SECRET, timestamp, body);
      const mw = createChatwootSignatureMiddleware({ now: () => NOW_MS });
      const req = makeReq({
        headers: { 'x-chatwoot-signature': signature, 'x-chatwoot-timestamp': timestamp },
        rawBody: body,
      });
      const res = makeRes() as unknown as Response;

      mw(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'STALE_TIMESTAMP' }));
      expect(next).not.toHaveBeenCalled();
    });
  });
});

describe('rawBodyJsonParser', () => {
  it('devuelve un json body-parser configurado con verify (captura req.rawBody)', () => {
    const mw = rawBodyJsonParser();
    expect(typeof mw).toBe('function');
  });
});
