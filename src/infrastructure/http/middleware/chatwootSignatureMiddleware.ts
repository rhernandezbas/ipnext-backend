import crypto from 'crypto';
import express, { Request, Response, NextFunction } from 'express';
import { config } from '@infrastructure/config';

/**
 * messaging-inbox (F1) — HMAC verification for the Chatwoot outbound webhook
 * (HOOK-1/HOOK-2). Style of `apiKeyMiddleware.ts`: responds DIRECTLY with
 * `res.status(401).json(...)` on any failure, never through `DomainError`/
 * `errorHandler` (idioma ya establecido para middlewares de auth).
 *
 * Chatwoot v4.13.0 signs the outbound webhook as:
 *   X-Chatwoot-Signature: sha256=<hex>
 *   <hex> = HMAC-SHA256(CHATWOOT_WEBHOOK_SECRET, "{X-Chatwoot-Timestamp}.{rawBody}")
 *   X-Chatwoot-Timestamp: <unix seconds> (anti-replay, HOOK-2)
 *
 * This middleware MUST run on a route where `req.rawBody` was captured by
 * `rawBodyJsonParser` (below) BEFORE the global `express.json()` touched the
 * body — recomputing over the parsed/re-serialized JSON would NOT match the
 * signature Chatwoot computed over the original bytes.
 */

const SIGNATURE_HEADER = 'x-chatwoot-signature';
const TIMESTAMP_HEADER = 'x-chatwoot-timestamp';
const SIGNATURE_PREFIX = 'sha256=';
/** HOOK-2 — anti-replay window: ±5min around the server clock. */
const REPLAY_WINDOW_MS = 5 * 60 * 1000;

export type RequestWithRawBody = Request & { rawBody?: Buffer };

export interface ChatwootSignatureMiddlewareOptions {
  /** Injectable clock (ms epoch) for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

function respondUnauthorized(res: Response, code: 'INVALID_SIGNATURE' | 'STALE_TIMESTAMP'): void {
  res.status(401).json({ error: 'Chatwoot webhook signature rejected', code });
}

/**
 * Parses `X-Chatwoot-Timestamp` as unix SECONDS (Rails/Chatwoot convention,
 * `Time.now.to_i`) into epoch milliseconds. Returns `null` if it isn't a
 * plain non-negative integer string — treated as fail-closed (STALE_TIMESTAMP)
 * by the caller, since the replay window can't be validated.
 */
function parseTimestampToMs(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds)) return null;
  return seconds * 1000;
}

/**
 * HOOK-1/HOOK-2 — recomputes the HMAC over the raw body and compares it
 * constant-time; validates the anti-replay window. Fail-closed on EVERY path:
 * no secret configured, missing/malformed headers, missing `req.rawBody`,
 * signature mismatch, or timestamp outside ±5min.
 */
export function createChatwootSignatureMiddleware(options: ChatwootSignatureMiddlewareOptions = {}) {
  const now = options.now ?? (() => Date.now());

  return function chatwootSignatureMiddleware(req: Request, res: Response, next: NextFunction): void {
    const secret = config.chatwoot.webhookSecret;
    if (!secret) {
      // Not configured -> the webhook is closed, same idiom as apiKeyMiddleware
      // when config.externalApi.apiKey is empty.
      respondUnauthorized(res, 'INVALID_SIGNATURE');
      return;
    }

    const rawBody = (req as RequestWithRawBody).rawBody;
    if (!Buffer.isBuffer(rawBody)) {
      // esc3 (HOOK-1): body already parsed/mutated upstream (or the raw-body
      // capture wasn't mounted on this route) -> NEVER default to "valid".
      respondUnauthorized(res, 'INVALID_SIGNATURE');
      return;
    }

    const signatureHeader = req.headers[SIGNATURE_HEADER];
    const timestampHeader = req.headers[TIMESTAMP_HEADER];
    if (typeof signatureHeader !== 'string' || typeof timestampHeader !== 'string') {
      respondUnauthorized(res, 'INVALID_SIGNATURE');
      return;
    }

    if (!signatureHeader.startsWith(SIGNATURE_PREFIX)) {
      respondUnauthorized(res, 'INVALID_SIGNATURE');
      return;
    }
    const providedHex = signatureHeader.slice(SIGNATURE_PREFIX.length);

    const expectedHex = crypto
      .createHmac('sha256', secret)
      .update(`${timestampHeader}.`)
      .update(rawBody)
      .digest('hex');

    const providedBuf = Buffer.from(providedHex, 'hex');
    const expectedBuf = Buffer.from(expectedHex, 'hex');

    // Guard length equality BEFORE timingSafeEqual — it throws on mismatched
    // buffer lengths instead of returning false, and a garbage/short header
    // must fail closed here, not crash the request.
    const validSignature =
      providedBuf.length > 0 &&
      providedBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(providedBuf, expectedBuf);

    if (!validSignature) {
      respondUnauthorized(res, 'INVALID_SIGNATURE');
      return;
    }

    const timestampMs = parseTimestampToMs(timestampHeader);
    if (timestampMs === null || Math.abs(now() - timestampMs) > REPLAY_WINDOW_MS) {
      respondUnauthorized(res, 'STALE_TIMESTAMP');
      return;
    }

    next();
  };
}

/**
 * Raw-body-capturing JSON parser for the Chatwoot webhook route only. Same
 * pattern as the tickets/comments override (`app.ts:829`): mounted on the
 * specific webhook path BEFORE the global `express.json()` so body-parser's
 * `req._body` guard skips the second parse — `chatwootSignatureMiddleware`
 * then sees the untouched bytes via `req.rawBody`.
 *
 * Wiring this into `app.ts` (which exact path, ordering relative to the
 * global parser) is B6's job — this only exports the reusable middleware.
 */
export function rawBodyJsonParser() {
  return express.json({
    verify: (req, _res, buf: Buffer) => {
      (req as RequestWithRawBody).rawBody = buf;
    },
  });
}
