import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import type { SessionRepository } from '@domain/ports/SessionRepository';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { ListRadiusSessions } from '@application/use-cases/ListRadiusSessions';
import { DisconnectSession } from '@application/use-cases/DisconnectSession';
import { ListRadiusEvents } from '@application/use-cases/ListRadiusEvents';
import { ListNe8000PppoeAudit } from '@application/use-cases/ListNe8000PppoeAudit';
import { ListRadiusAuthFailures } from '@application/use-cases/ListRadiusAuthFailures';
import { ListRadiusSessionCures } from '@application/use-cases/ListRadiusSessionCures';
import { CureStuckSession } from '@application/use-cases/CureStuckSession';
import type { RadiusAuthReply } from '@domain/entities/radius-auth-event';

type RequirePerm = (module: RbacModuleCode, action: PermissionAction) => RequestHandler;

/** Valores válidos para los filtros enum de las rutas de auditoría. */
const VALID_EVENT_TYPES    = new Set(['start', 'stop', 'interim']);
const VALID_PPPOE_STATUSES = new Set(['enabled', 'disabled']);
const VALID_ENFORCED       = new Set(['active', 'reduced', 'blocked']);
const VALID_AUTH_REPLIES   = new Set(['Access-Accept', 'Access-Reject']);
const VALID_AUTH_REASONS   = new Set(['session_stuck', 'user_not_found', 'other']);
const VALID_SESSION_STATUS = new Set(['active', 'idle']);
const VALID_CURE_OUTCOMES  = new Set([
  'cured', 'already_cured', 'skipped_alive', 'skipped_ambiguous',
  'skipped_no_session', 'skipped_no_signal', 'flagged_flapping', 'failed',
]);
const VALID_CURE_TRIGGERS  = new Set(['auto', 'manual']);

/**
 * FIX5: parseIntPositive — devuelve el número si es un entero positivo válido; NaN si no.
 * Rechaza strings no-numéricos, cero y negativos.
 */
function parseIntPositive(s: string | undefined): number | undefined | 'invalid' {
  if (s === undefined) return undefined;
  const n = parseInt(s, 10);
  if (isNaN(n) || n <= 0 || String(n) !== s) return 'invalid';
  return n;
}

/**
 * FIX5: parseIntNonNeg — igual que parseIntPositive pero permite 0 (para vlanId).
 * Rechaza strings no-numéricos y negativos.
 */
function parseIntNonNeg(s: string | undefined): number | undefined | 'invalid' {
  if (s === undefined) return undefined;
  const n = parseInt(s, 10);
  if (isNaN(n) || n < 0 || String(n) !== s) return 'invalid';
  return n;
}

/**
 * FIX5: parseDate — devuelve el ISO string si es parseable como Date válido; undefined si no.
 */
function parseDate(s: string | undefined): string | undefined | 'invalid' {
  if (s === undefined) return undefined;
  const d = new Date(s);
  if (isNaN(d.getTime())) return 'invalid';
  return s;
}

/**
 * W1/W2: normalizeQueryParam — normaliza un query param que debe ser un string simple.
 *
 * - Ausente → undefined (sin filtro).
 * - No-string (array — param repetido, ej. `?search=a&search=b`) → 'invalid' (W2: 400, no 500).
 * - String vacío `''` → undefined (W1: "sin filtro", coherente entre search/nasId/status).
 * - String no vacío → se devuelve tal cual.
 */
function normalizeQueryParam(v: unknown): string | undefined | 'invalid' {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') return 'invalid';
  return v === '' ? undefined : v;
}

/**
 * Sesiones RADIUS + Auditoría de red.
 *
 * `network.read`:   GET /sessions, GET /events, GET /ne8000/audit, GET /auth-failures,
 *                    GET /session-cures
 * `network.manage`: DELETE /sessions/:id, POST /session-cures
 */
export function createRadiusRouter(
  authProvider: AuthProvider,
  sessionRepo: SessionRepository | undefined,
  requirePerm: RequirePerm,
  listRadiusSessions: ListRadiusSessions,
  disconnectSession: DisconnectSession,
  listRadiusEvents: ListRadiusEvents,
  listNe8000Audit: ListNe8000PppoeAudit,
  listRadiusAuthFailures: ListRadiusAuthFailures,
  listRadiusSessionCures: ListRadiusSessionCures,
  cureStuckSession: CureStuckSession,
): Router {
  const router = Router();
  const auth      = createAuthMiddleware(authProvider, sessionRepo);
  const canRead   = requirePerm('network', 'read');
  const canManage = requirePerm('network', 'manage');

  // ── Sesiones RADIUS — GET /sessions ─────────────────────────────────────────
  // Sin params → array legacy RadiusSession[] (back-compat; tests Array.isArray intactos).
  // Con al menos un param → envelope { data, total, page, limit, hasNext, stats }.
  // network-sessions-pools-redesign: filtros search/nasId/status + paginación page/limit.

  router.get('/sessions', auth, canRead, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const q = req.query;
      const hasParams = Object.keys(q).some(k => ['search', 'nasId', 'status', 'page', 'limit'].includes(k));

      if (!hasParams) {
        // Back-compat: sin params → array legacy
        const sessions = await listRadiusSessions.execute();
        res.json(sessions);
        return;
      }

      // W1/W2: normalizar search/nasId/status — deben ser un string simple (no array de
      // param repetido) y '' se trata como "sin filtro" (coherente entre los 3).
      const search = normalizeQueryParam(q['search']);
      const nasId  = normalizeQueryParam(q['nasId']);
      const status = normalizeQueryParam(q['status']);
      if (search === 'invalid') { res.status(400).json({ code: 'VALIDATION_ERROR', message: 'search must be a single string value' }); return; }
      if (nasId  === 'invalid') { res.status(400).json({ code: 'VALIDATION_ERROR', message: 'nasId must be a single string value' }); return; }
      if (status === 'invalid') { res.status(400).json({ code: 'VALIDATION_ERROR', message: 'status must be a single string value' }); return; }

      // Validar status (enum) — solo si vino un valor no vacío (W1: '' = sin filtro, no valida).
      if (status !== undefined && !VALID_SESSION_STATUS.has(status)) {
        res.status(400).json({ code: 'VALIDATION_ERROR', message: 'status must be active | idle' });
        return;
      }

      // Validar page y limit (enteros positivos)
      const page  = parseIntPositive(q['page']  as string | undefined);
      const limit = parseIntPositive(q['limit'] as string | undefined);
      if (page  === 'invalid') { res.status(400).json({ code: 'VALIDATION_ERROR', message: 'page must be a positive integer' }); return; }
      if (limit === 'invalid') { res.status(400).json({ code: 'VALIDATION_ERROR', message: 'limit must be a positive integer' }); return; }

      const result = await listRadiusSessions.execute({
        search,
        nasId,
        status: status as 'active' | 'idle' | undefined,
        page,
        limit,
      });
      res.json(result);
    } catch (err) {
      // Express 4 sin express-async-errors: el throw dentro de un handler async NO llega
      // al errorHandler — hay que encaminarlo explícitamente (patrón auditEvents.routes.ts).
      next(err);
    }
  });

  router.delete('/sessions/:id', auth, canManage, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await disconnectSession.execute(req.params['id'] as string);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // ── GET /events — Logs RADIUS ────────────────────────────────────────────────
  // FIX4: listRadiusEvents ahora es REQUERIDO (sin ?) — la ruta SIEMPRE se registra.
  // FIX5: validación de inputs numéricos y fechas antes de llamar al use case.
  router.get('/events', auth, canRead, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const q = req.query;

      // REQ-FILTER-8: validar eventType
      if (q['eventType'] !== undefined && !VALID_EVENT_TYPES.has(q['eventType'] as string)) {
        res.status(400).json({ code: 'VALIDATION_ERROR', message: 'eventType must be start | stop | interim' });
        return;
      }

      // FIX5: validar page y limit (enteros positivos)
      const page  = parseIntPositive(q['page']  as string | undefined);
      const limit = parseIntPositive(q['limit'] as string | undefined);
      if (page  === 'invalid') { res.status(400).json({ code: 'VALIDATION_ERROR', message: 'page must be a positive integer' }); return; }
      if (limit === 'invalid') { res.status(400).json({ code: 'VALIDATION_ERROR', message: 'limit must be a positive integer' }); return; }

      // FIX5: validar vlanId (entero no negativo)
      const vlanId = parseIntNonNeg(q['vlanId'] as string | undefined);
      if (vlanId === 'invalid') { res.status(400).json({ code: 'VALIDATION_ERROR', message: 'vlanId must be a non-negative integer' }); return; }

      // FIX5: validar from/to (fechas parseables)
      const from = parseDate(q['from'] as string | undefined);
      const to   = parseDate(q['to']   as string | undefined);
      if (from === 'invalid') { res.status(400).json({ code: 'VALIDATION_ERROR', message: 'from must be a valid ISO 8601 date' }); return; }
      if (to   === 'invalid') { res.status(400).json({ code: 'VALIDATION_ERROR', message: 'to must be a valid ISO 8601 date' }); return; }

      const online = q['online'] !== undefined
        ? q['online'] === 'true'
        : undefined;

      const result = await listRadiusEvents.execute({
        username:  q['username']  as string | undefined,
        nasId:     q['nasId']     as string | undefined,
        vlanId,
        eventType: q['eventType'] as 'start' | 'stop' | 'interim' | undefined,
        online,
        from,
        to,
        page,
        limit,
      });

      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // ── GET /ne8000/audit — Auditoría NE8000 ────────────────────────────────────
  // FIX4: listNe8000Audit ahora es REQUERIDO (sin ?) — la ruta SIEMPRE se registra.
  // FIX5: validación de inputs numéricos antes de llamar al use case.
  router.get('/ne8000/audit', auth, canRead, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const q = req.query;

      // REQ-FILTER-3: validar status
      if (q['status'] !== undefined && !VALID_PPPOE_STATUSES.has(q['status'] as string)) {
        res.status(400).json({ code: 'VALIDATION_ERROR', message: 'status must be enabled | disabled' });
        return;
      }

      // REQ-FILTER-4: validar enforcedState
      if (q['enforcedState'] !== undefined && !VALID_ENFORCED.has(q['enforcedState'] as string)) {
        res.status(400).json({ code: 'VALIDATION_ERROR', message: 'enforcedState must be active | reduced | blocked' });
        return;
      }

      // FIX5: validar page y limit (enteros positivos)
      const page  = parseIntPositive(q['page']  as string | undefined);
      const limit = parseIntPositive(q['limit'] as string | undefined);
      if (page  === 'invalid') { res.status(400).json({ code: 'VALIDATION_ERROR', message: 'page must be a positive integer' }); return; }
      if (limit === 'invalid') { res.status(400).json({ code: 'VALIDATION_ERROR', message: 'limit must be a positive integer' }); return; }

      const online = q['online'] !== undefined
        ? q['online'] === 'true'
        : undefined;

      const result = await listNe8000Audit.execute({
        username:      q['username']      as string | undefined,
        status:        q['status']        as string | undefined,
        enforcedState: q['enforcedState'] as string | undefined,
        online,
        page,
        limit,
      });

      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // ── GET /auth-failures — eventos de autenticación RADIUS (radpostauth) ───────
  // Espejo de /events: gate network.read + validación de inputs.
  router.get('/auth-failures', auth, canRead, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const q = req.query;

      // Validar reply (opcional): Access-Accept | Access-Reject
      if (q['reply'] !== undefined && !VALID_AUTH_REPLIES.has(q['reply'] as string)) {
        res.status(400).json({ code: 'VALIDATION_ERROR', message: 'reply must be Access-Accept | Access-Reject' });
        return;
      }

      // Validar reason (opcional): session_stuck | user_not_found | other
      if (q['reason'] !== undefined && !VALID_AUTH_REASONS.has(q['reason'] as string)) {
        res.status(400).json({ code: 'VALIDATION_ERROR', message: 'reason must be session_stuck | user_not_found | other' });
        return;
      }

      // Validar page y limit (enteros positivos)
      const page  = parseIntPositive(q['page']  as string | undefined);
      const limit = parseIntPositive(q['limit'] as string | undefined);
      if (page  === 'invalid') { res.status(400).json({ code: 'VALIDATION_ERROR', message: 'page must be a positive integer' }); return; }
      if (limit === 'invalid') { res.status(400).json({ code: 'VALIDATION_ERROR', message: 'limit must be a positive integer' }); return; }

      // Validar from/to (fechas parseables)
      const from = parseDate(q['from'] as string | undefined);
      const to   = parseDate(q['to']   as string | undefined);
      if (from === 'invalid') { res.status(400).json({ code: 'VALIDATION_ERROR', message: 'from must be a valid ISO 8601 date' }); return; }
      if (to   === 'invalid') { res.status(400).json({ code: 'VALIDATION_ERROR', message: 'to must be a valid ISO 8601 date' }); return; }

      const result = await listRadiusAuthFailures.execute({
        username: q['username'] as string | undefined,
        reply:    q['reply']    as RadiusAuthReply | undefined,
        reason:   q['reason']   as string | undefined,
        from,
        to,
        page,
        limit,
      });

      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // ── GET /session-cures — auditoría de curas de sesiones RADIUS colgadas ──────
  // radius-session-autocure BE-1 (REQ-CURE-5). Espejo de /auth-failures: gate network.read +
  // validación defensiva.
  router.get('/session-cures', auth, canRead, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const q = req.query;

      if (q['outcome'] !== undefined && !VALID_CURE_OUTCOMES.has(q['outcome'] as string)) {
        res.status(400).json({ code: 'VALIDATION_ERROR', message: 'outcome inválido' });
        return;
      }
      if (q['trigger'] !== undefined && !VALID_CURE_TRIGGERS.has(q['trigger'] as string)) {
        res.status(400).json({ code: 'VALIDATION_ERROR', message: 'trigger must be auto | manual' });
        return;
      }

      const page  = parseIntPositive(q['page']  as string | undefined);
      const limit = parseIntPositive(q['limit'] as string | undefined);
      if (page  === 'invalid') { res.status(400).json({ code: 'VALIDATION_ERROR', message: 'page must be a positive integer' }); return; }
      if (limit === 'invalid') { res.status(400).json({ code: 'VALIDATION_ERROR', message: 'limit must be a positive integer' }); return; }

      const from = parseDate(q['from'] as string | undefined);
      const to   = parseDate(q['to']   as string | undefined);
      if (from === 'invalid') { res.status(400).json({ code: 'VALIDATION_ERROR', message: 'from must be a valid ISO 8601 date' }); return; }
      if (to   === 'invalid') { res.status(400).json({ code: 'VALIDATION_ERROR', message: 'to must be a valid ISO 8601 date' }); return; }

      const result = await listRadiusSessionCures.execute({
        username: q['username'] as string | undefined,
        outcome:  q['outcome']  as string | undefined,
        trigger:  q['trigger']  as string | undefined,
        from,
        to,
        page,
        limit,
      });

      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // ── POST /session-cures — cura MANUAL (escape hatch auditado) ────────────────
  // radius-session-autocure BE-1 (REQ-CURE-6). Gate network.manage (espejo del disconnect
  // manual). Ejecuta el MISMO core CureStuckSession que el watcher. Sin `force`: respeta los
  // gates fail-closed (alive/ambiguous → 409 tipado, SIN curar). Con `force: true`: los saltea.
  // SIEMPRE registra fila (incl. los 409) — el core ya lo garantiza (trigger 'manual' nunca
  // pasa por el cure-throttle/flapping/throttle de registro).
  router.post('/session-cures', auth, canManage, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = req.body as { username?: unknown; sessionId?: unknown; force?: unknown };

      if (typeof body.username !== 'string' || body.username.trim() === '') {
        res.status(400).json({ code: 'VALIDATION_ERROR', message: 'username es requerido' });
        return;
      }
      if (body.sessionId !== undefined && typeof body.sessionId !== 'string') {
        res.status(400).json({ code: 'VALIDATION_ERROR', message: 'sessionId debe ser string' });
        return;
      }
      if (body.force !== undefined && typeof body.force !== 'boolean') {
        res.status(400).json({ code: 'VALIDATION_ERROR', message: 'force debe ser boolean' });
        return;
      }

      const force = body.force === true;
      const actorName = req.user?.username ?? 'operador';

      const result = await cureStuckSession.execute({
        username: body.username,
        trigger: 'manual',
        actorName,
        sessionId: body.sessionId as string | undefined,
        force,
      });

      const responseBody = {
        outcome: result.outcome,
        reason: result.reason,
        events: result.events.map((e) => ({
          id: e.id, username: e.username, nasIp: e.nasIp, sessionId: e.sessionId,
          sessionStartedAt: e.sessionStartedAt, sessionLastUpdate: e.sessionLastUpdate,
          signalUsed: e.signalUsed, trigger: e.trigger, action: e.action, outcome: e.outcome,
          reason: e.reason, actorName: e.actorName, createdAt: e.createdAt,
        })),
      };

      // Sin force: alive/ambiguous son gates fail-closed que el operador puede saltear con una
      // segunda confirmación explícita (force:true) — 409 tipado, NUNCA curan sin esa decisión.
      if (!force && result.outcome === 'skipped_alive') {
        res.status(409).json({ code: 'CURE_SKIPPED_ALIVE', message: result.reason, ...responseBody });
        return;
      }
      if (!force && result.outcome === 'skipped_ambiguous') {
        res.status(409).json({ code: 'CURE_SKIPPED_AMBIGUOUS', message: result.reason, ...responseBody });
        return;
      }

      res.json(responseBody);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
