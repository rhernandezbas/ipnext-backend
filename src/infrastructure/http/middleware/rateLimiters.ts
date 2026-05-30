/**
 * Rate limiters (SDD #6a). The login limiter throttles brute-force on the auth
 * endpoint. Behind EasyPanel's proxy, the app must `app.set('trust proxy', 1)`
 * so the limiter keys on the real client IP (not the proxy's).
 */
import { rateLimit } from 'express-rate-limit';
import type { Request, Response, RequestHandler } from 'express';

export interface LoginRateLimitOptions {
  windowMs?: number;
  limit?: number;
}

const DEFAULT_WINDOW_MS = 15 * 60 * 1000; // 15 min
const DEFAULT_LIMIT = 10;

export function createLoginRateLimiter(opts: LoginRateLimitOptions = {}): RequestHandler {
  return rateLimit({
    windowMs: opts.windowMs ?? DEFAULT_WINDOW_MS,
    limit: opts.limit ?? DEFAULT_LIMIT,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req: Request, res: Response) => {
      res.status(429).json({
        error: 'Demasiados intentos de inicio de sesión. Probá de nuevo más tarde.',
        code: 'RATE_LIMITED',
      });
    },
  });
}
