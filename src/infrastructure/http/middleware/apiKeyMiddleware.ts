import { Request, Response, NextFunction } from 'express';
import { config } from '@infrastructure/config';

/**
 * API-key middleware for the external API (/api/external/v1).
 * Reads the key from X-API-Key header OR Authorization: Bearer <key>.
 * Returns 401 if:
 *   - no key is provided
 *   - config.externalApi.apiKey is empty (API not configured → closed)
 *   - key doesn't match the configured key
 * Does NOT set req.user — this is machine-to-machine auth only.
 */
export function createApiKeyMiddleware() {
  return function apiKeyMiddleware(req: Request, res: Response, next: NextFunction): void {
    const configuredKey = config.externalApi.apiKey;

    // If no key is configured, the external API is closed — always 401.
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
