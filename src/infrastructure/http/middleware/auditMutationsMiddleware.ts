/**
 * auditMutationsMiddleware — generic audit of mutations (SDD #4 Phase 2).
 *
 * Mounted globally after express.json/cookieParser and the per-router auth
 * middleware. Audits every POST/PUT/PATCH/DELETE under /api:
 * - captures the response body by wrapping res.json
 * - records on res.on('finish') (so req.user, set by the per-router auth MW,
 *   and the final status code are available; and it adds no perceived latency)
 * - dedupes against AuditService.emit via res.locals.__auditEmitted
 *
 * Auditing NEVER breaks the request: record failures are logged, not thrown.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { AuditEventRepository } from '@domain/ports/AuditEventRepository';

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * F2 (noc-alerts-config) — M2M-only alert surfaces (sensors/Grafana ingest,
 * Telegram's own servers hitting the webhook) never carry a `req.user` — the
 * generic row this middleware would write is a dead `action=null,
 * entityType=null, actorLogin='anonymous'` entry, not filterable/attributable
 * to anything. `POST /api/alerts/telegram/webhook`'s real mutation (the ACK)
 * already gets a RICH structured event straight from `AcknowledgeAlert`
 * (entityType='NocAlert', entityId, actor, channel — see its doc comment).
 * `POST /api/alerts/ingest/:source` has no structured equivalent (out of
 * scope here) but is excluded anyway — same M2M reasoning, and ingestion
 * volume would otherwise flood the audit log with noise no admin can use.
 * Prefix match on the ORIGINAL url (not parsed params) — cheap, no route
 * table dependency.
 */
const EXCLUDED_MUTATION_PATH_PREFIXES = ['/api/alerts/ingest/', '/api/alerts/telegram/webhook'];

function isExcludedFromGenericAudit(url: string): boolean {
  return EXCLUDED_MUTATION_PATH_PREFIXES.some(prefix => url.startsWith(prefix));
}

/** Keys whose values are replaced with '***' before persisting (case-insensitive). */
const SENSITIVE_KEYS = new Set([
  'password',
  'newpassword',
  'currentpassword',
  'oldpassword',
  'token',
  'secret',
  'passwordhash',
  // #65 — the deterministic TV password persisted on the ContractService. The change-password
  // route body carries `password` (already masked); this also covers any path that echoes the
  // persisted field name back through a mutation body.
  'tvpassword',
  // C1: the Gigared API key — PUT /api/gigared/config sends `apiKey` (snake variant `api_key`).
  // NOT 'apikeylast4' — the last-4 tail is the public preview returned by GET /config.
  'apikey',
  'api_key',
  // customer-portal-api fix wave C1 — the portal auth surface moves LIVE tokens
  // through mutation bodies: login/refresh RESPONSES carry {accessToken,
  // refreshToken} and refresh/logout REQUESTS carry {refreshToken}. Without
  // these keys the generic audit persisted usable portal credentials in
  // AuditEvent (readable via GET /api/admin/audit-events).
  'accesstoken',
  'refreshtoken',
]);

/**
 * Strings >= this many bytes that look like a `data:` URI are elided before
 * persisting, so a single base64 attachment can't bloat an AuditEvent to MBs.
 */
const DATA_URI_ELIDE_THRESHOLD_BYTES = 1024;

/**
 * If `value` is a `data:` URI string above the threshold, replace it with a
 * short placeholder that records the original byte length. Generic — covers any
 * current or future upload field, not just ticket comments. Returns the value
 * unchanged otherwise.
 */
function elideDataUri(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (value.length < DATA_URI_ELIDE_THRESHOLD_BYTES) return value;
  if (!value.startsWith('data:')) return value;
  return `data:[elided ${value.length} bytes]`;
}

/** Recursively mask sensitive values. Pure; null/undefined-safe. */
export function maskSensitive(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(maskSensitive);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? '***' : maskSensitive(v);
    }
    return out;
  }
  return elideDataUri(value);
}

function extractErrorMessage(body: unknown): string | null {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    if (typeof b['error'] === 'string') return b['error'];
    if (typeof b['message'] === 'string') return b['message'];
    if (typeof b['code'] === 'string') return b['code'];
  }
  if (typeof body === 'string' && body.length > 0) return body;
  return null;
}

export function auditMutationsMiddleware(repo: AuditEventRepository): RequestHandler {
  return function auditMutations(req: Request, res: Response, next: NextFunction): void {
    const url = req.originalUrl || req.url || '';
    if (!MUTATION_METHODS.has(req.method) || !url.startsWith('/api') || isExcludedFromGenericAudit(url)) {
      next();
      return;
    }

    // Capture the response body so the audit "after" reflects what was returned.
    const originalJson = res.json.bind(res);
    res.json = function patchedJson(body: unknown) {
      res.locals['__auditResBody'] = body;
      return originalJson(body);
    } as Response['json'];

    res.on('finish', () => {
      // A use case already emitted a richer event for this request → don't duplicate.
      if (res.locals['__auditEmitted']) return;

      const status = res.statusCode;
      const isError = status >= 400;
      const resBody = res.locals['__auditResBody'];
      const actor = (req as Request & { user?: { id?: string; username?: string } }).user;

      void repo
        .record({
          actorId: actor?.id ?? null,
          actorLogin: actor?.username ?? 'anonymous',
          method: req.method,
          path: url,
          action: null,
          entityType: null,
          entityId: null,
          beforeJson: maskSensitive(req.body ?? null),
          afterJson: isError ? null : maskSensitive(resBody ?? null),
          statusCode: status,
          errorMessage: isError ? extractErrorMessage(resBody) : null,
          ip: req.ip ?? null,
        })
        .catch((err: unknown) => {
          // Auditing must never break the request path.
          console.error('[audit] failed to record mutation', err);
        });
    });

    next();
  };
}
