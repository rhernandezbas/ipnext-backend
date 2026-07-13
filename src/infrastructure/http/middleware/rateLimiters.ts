/**
 * Rate limiters (SDD #6a). The login limiter throttles brute-force on the auth
 * endpoint. Behind EasyPanel's proxy, the app must `app.set('trust proxy', 1)`
 * so the limiter keys on the real client IP (not the proxy's).
 *
 * login-ratelimit-nat (incidente 2026-06-30): el keyGenerator por-IP agrupaba a
 * TODOS los empleados detrás del NAT de la oficina (misma IP pública) → 10 logins/15min
 * se saturaba con la oficina entera y todos recibían 429. Fix: keyear por (IP + username)
 * para limitar el brute-force contra UN usuario SIN penalizar a usuarios distintos que
 * comparten la IP de salida. Límite/ventana configurables por env.
 */
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import type { Request, Response, RequestHandler } from 'express';

export interface LoginRateLimitOptions {
  windowMs?: number;
  limit?: number;
}

const DEFAULT_WINDOW_MS = 15 * 60 * 1000; // 15 min
// Por (IP + username). 20 da margen a typos/reintentos legítimos de un usuario sin
// abrir la puerta al brute-force (un humano no falla 20 veces en 15 min; un bot sí).
const DEFAULT_LIMIT = 20;

export function createLoginRateLimiter(opts: LoginRateLimitOptions = {}): RequestHandler {
  return rateLimit({
    windowMs: opts.windowMs ?? DEFAULT_WINDOW_MS,
    limit: opts.limit ?? DEFAULT_LIMIT,
    standardHeaders: true,
    legacyHeaders: false,
    /**
     * Key = IP + username. `ipKeyGenerator` es el helper de express-rate-limit (IPv6-safe;
     * v8 lo EXIGE en vez de `req.ip` crudo, o tira ERR_ERL_KEY_GEN_IPV6). El username sale
     * del body ya parseado por express.json() (montado antes del router /api/auth). Sin
     * username (request inválido) cae a `ip:` — el handler igual lo rechaza con 401/400.
     */
    keyGenerator: (req: Request) => {
      const ipKey = ipKeyGenerator(req.ip ?? '');
      const body = req.body as { username?: unknown } | undefined;
      const username = typeof body?.username === 'string' ? body.username.toLowerCase().trim() : '';
      return `${ipKey}:${username}`;
    },
    handler: (_req: Request, res: Response) => {
      res.status(429).json({
        error: 'Demasiados intentos de inicio de sesión. Probá de nuevo más tarde.',
        code: 'RATE_LIMITED',
      });
    },
  });
}

/**
 * messaging-inbox-v2-media (Tanda 2, fix-be #2 [ALTO]) — rate limiter para
 * `POST /api/messaging/conversations/:id/messages`. Sin esto, multer's memoryStorage
 * permite hasta 100MB × 10 archivos = 1GB en RAM por request sin ningún techo sobre
 * cuántos requests puede sostener un mismo agente por minuto — el cap de tamaño de
 * batch (`MAX_TOTAL_BATCH_BYTES`, messaging.routes.ts) reduce el pico por request,
 * pero no evita que se repita en ráfaga.
 *
 * Mismo gotcha que `login-ratelimit-nat` (incidente 2026-06-30): esta ruta corre
 * DETRÁS de auth (RBAC `messaging:send`), así que a diferencia del login SIEMPRE hay
 * un `req.user.id` resuelto — keyear por IP sola agruparía a toda una oficina detrás
 * del mismo NAT bajo un solo cupo. Keyea por usuario autenticado; cae a IP solo en el
 * caso defensivo (no debería pasar nunca) de que `req.user` no esté seteado todavía.
 */
export interface MessagingSendRateLimitOptions {
  windowMs?: number;
  limit?: number;
}

const DEFAULT_MESSAGING_SEND_WINDOW_MS = 5 * 60 * 1000; // 5 min
// 30 envíos/5min por agente — generoso para uso normal (un agente humano no manda
// 30 mensajes con adjuntos en 5 min), corta un abuso sostenido de payloads grandes.
const DEFAULT_MESSAGING_SEND_LIMIT = 30;

export function createMessagingSendRateLimiter(opts: MessagingSendRateLimitOptions = {}): RequestHandler {
  return rateLimit({
    windowMs: opts.windowMs ?? DEFAULT_MESSAGING_SEND_WINDOW_MS,
    limit: opts.limit ?? DEFAULT_MESSAGING_SEND_LIMIT,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => {
      const userId = (req as unknown as { user?: { id?: string } }).user?.id;
      if (userId) return `user:${userId}`;
      return `ip:${ipKeyGenerator(req.ip ?? '')}`;
    },
    handler: (_req: Request, res: Response) => {
      res.status(429).json({
        error: 'Demasiados envíos con adjuntos en poco tiempo. Probá de nuevo en unos minutos.',
        code: 'RATE_LIMITED',
      });
    },
  });
}
