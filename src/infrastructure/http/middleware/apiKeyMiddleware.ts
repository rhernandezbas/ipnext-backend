import { Request, Response, NextFunction } from 'express';
import { config } from '@infrastructure/config';

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

    if (!providedKey || providedKey !== configuredKey) {
      res.status(401).json({ error: 'Invalid or missing API key', code: 'UNAUTHORIZED' });
      return;
    }

    next();
  };
}
