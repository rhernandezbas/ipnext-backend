import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { config } from '@infrastructure/config';

/**
 * F7 (fix wave, noc-alerts-hub) — constant-time key comparison. `!==` on strings
 * short-circuits on the first differing byte, leaking a timing signal an attacker
 * can use to brute-force the key one byte at a time. `timingSafeEqual` needs
 * equal-length buffers or it throws — pad the shorter one with a fixed-length
 * buffer so the comparison itself still runs in constant time relative to the
 * padded length (only the final boolean depends on the real equality), instead
 * of returning early on a length mismatch.
 */
export function safeCompare(provided: string, configured: string): boolean {
  const providedBuf = Buffer.from(provided);
  const configuredBuf = Buffer.from(configured);
  const len = Math.max(providedBuf.length, configuredBuf.length, 1);
  const paddedProvided = Buffer.alloc(len);
  const paddedConfigured = Buffer.alloc(len);
  providedBuf.copy(paddedProvided);
  configuredBuf.copy(paddedConfigured);
  const buffersEqual = timingSafeEqual(paddedProvided, paddedConfigured);
  return buffersEqual && providedBuf.length === configuredBuf.length;
}

/**
 * API-key middleware factory. Reads the key from X-API-Key header OR
 * Authorization: Bearer <key>. Returns 401 if:
 *   - no key is provided
 *   - the configured key is empty (source not configured → closed)
 *   - key doesn't match the configured key
 * Does NOT set req.user — this is machine-to-machine auth only.
 *
 * Parametrized by source (noc-alerts-hub A18): `configuredKey` is now an
 * explicit argument instead of hardcoding `config.externalApi.apiKey`, so each
 * source (external API, Grafana ingest, fiber-collector ingest) rotates its OWN
 * key independently. Optional/undefined preserves the ORIGINAL behaviour —
 * `createApiKeyMiddleware()` (no args) still reads `config.externalApi.apiKey`,
 * so `/api/external/v1` (and its 4 existing test suites) are UNCHANGED.
 */
export function createApiKeyMiddleware(configuredKey: string = config.externalApi.apiKey) {
  return function apiKeyMiddleware(req: Request, res: Response, next: NextFunction): void {
    // If no key is configured, the source is closed — always 401.
    if (!configuredKey) {
      res.status(401).json({ error: 'Invalid or missing API key', code: 'UNAUTHORIZED' });
      return;
    }

    // Read key from X-API-Key header first, then Authorization: Bearer <key>
    let providedKey: string | undefined;
    const xApiKey = req.headers['x-api-key'];
    if (typeof xApiKey === 'string' && xApiKey.length > 0) {
      providedKey = xApiKey;
    } else {
      const authHeader = req.headers['authorization'];
      if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
        providedKey = authHeader.slice('Bearer '.length);
      }
    }

    if (!providedKey || !safeCompare(providedKey, configuredKey)) {
      res.status(401).json({ error: 'Invalid or missing API key', code: 'UNAUTHORIZED' });
      return;
    }

    next();
  };
}

/**
 * Fase D (`noc-alert-telegram`) — spec.md "Inbound webhook requires a valid
 * secret token": `POST /api/alerts/telegram/webhook` is guarded by Telegram's
 * OWN shared-secret header (`X-Telegram-Bot-Api-Secret-Token`, set when the
 * webhook is registered with Telegram), NOT `X-API-Key`/`Bearer` like
 * `createApiKeyMiddleware` above — a different header, same fail-closed
 * contract (empty configured secret → always 401, constant-time compare via
 * the SAME `safeCompare`). Never sets `req.user` — machine-to-machine only.
 */
export function createTelegramSecretMiddleware(configuredSecret: string = config.alerts.telegramWebhookSecret) {
  return function telegramSecretMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (!configuredSecret) {
      res.status(401).json({ error: 'Invalid or missing Telegram secret token', code: 'UNAUTHORIZED' });
      return;
    }

    const provided = req.headers['x-telegram-bot-api-secret-token'];
    if (typeof provided !== 'string' || !safeCompare(provided, configuredSecret)) {
      res.status(401).json({ error: 'Invalid or missing Telegram secret token', code: 'UNAUTHORIZED' });
      return;
    }

    next();
  };
}
