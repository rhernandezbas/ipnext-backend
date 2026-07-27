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

/**
 * external-create-ticket — rate limiter for the external WRITE surface
 * (`POST /api/external/v1/tickets`). The external API is machine-to-machine
 * (API key, NO session → no `req.user`), so a public write with no ceiling is an
 * abuse vector (mass ticket creation). Applied ONLY to the POST, never to the
 * existing read GETs (#150/#152) — those stay untouched to not break consumers.
 *
 * Keyed by IP: today there is a SINGLE shared API key, so per-consumer keying is
 * impossible. DEUDA (BACKLOG "API Externa — el mapa", hardening): when per-consumer
 * API keys land, key by consumer id instead of IP.
 */
export interface ExternalWriteRateLimitOptions {
  windowMs?: number;
  limit?: number;
}

const DEFAULT_EXTERNAL_WRITE_WINDOW_MS = 60 * 1000; // 1 min
// 30 writes/min per IP — generous for a legit integration, cuts sustained abuse.
const DEFAULT_EXTERNAL_WRITE_LIMIT = 30;

export function createExternalWriteRateLimiter(opts: ExternalWriteRateLimitOptions = {}): RequestHandler {
  return rateLimit({
    windowMs: opts.windowMs ?? DEFAULT_EXTERNAL_WRITE_WINDOW_MS,
    limit: opts.limit ?? DEFAULT_EXTERNAL_WRITE_LIMIT,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => `ip:${ipKeyGenerator(req.ip ?? '')}`,
    handler: (_req: Request, res: Response) => {
      res.status(429).json({
        error: 'Too many requests. Retry later.',
        code: 'RATE_LIMITED',
      });
    },
  });
}

/**
 * alerts-ingest-ratelimit (fix, incidente en vivo 2026-07-26) — `POST
 * /api/alerts/ingest/:source` reusaba `createExternalWriteRateLimiter()`
 * (30 req/60s por IP), pensado para el API externo de tickets (escritura
 * pública genérica). El colector de fibra (VM 130) postea UNA request por
 * alerta: ~29/ciclo (9 PON + 20 individuales) cada 30 min — al filo de 30/min,
 * ya rebotó alertas reales con `HTTP 429` en prod. Durante un INCIDENTE
 * (muchas ONUs degradando a la vez) el burst crece mucho más → se pierden
 * alertas justo cuando más importan. Esta ruta es máquina-a-máquina,
 * autenticada con shared-secret POR FUENTE (ver `ingestKeys` en
 * `alerts.routes.ts`) — el rate limit acá es protección anti-abuso, NO
 * shaping de throughput de un consumidor propio ya autenticado.
 *
 * Default: 600 req/60s. Cubre un incidente grande (hasta 600 ONUs degradando
 * en un mismo ciclo de 30 min, ~20x el burst normal medido) sin dejar de ser
 * un techo real: un abuso sostenido de miles de req/min contra la key de un
 * source siendo la única clave compartida hoy (deuda ya documentada en
 * `createExternalWriteRateLimiter`) igual queda cortado. Configurable por env
 * (`ALERTS_INGEST_RATE_LIMIT` / `ALERTS_INGEST_RATE_WINDOW_MS`, ver
 * `config.ts`) por si el ciclo del colector o el tamaño de un incidente real
 * cambian sin requerir un redeploy de código.
 */
export interface IngestRateLimitOptions {
  windowMs?: number;
  limit?: number;
}

const DEFAULT_INGEST_WINDOW_MS = 60 * 1000; // 1 min
const DEFAULT_INGEST_LIMIT = 600; // 600 req/min — ver justificación arriba.

export function createIngestRateLimiter(opts: IngestRateLimitOptions = {}): RequestHandler {
  return rateLimit({
    windowMs: opts.windowMs ?? DEFAULT_INGEST_WINDOW_MS,
    limit: opts.limit ?? DEFAULT_INGEST_LIMIT,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => `ip:${ipKeyGenerator(req.ip ?? '')}`,
    handler: (_req: Request, res: Response) => {
      res.status(429).json({
        error: 'Too many requests. Retry later.',
        code: 'RATE_LIMITED',
      });
    },
  });
}
