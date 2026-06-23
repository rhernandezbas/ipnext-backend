import { Router, Request, Response, RequestHandler } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import type { SessionRepository } from '@domain/ports/SessionRepository';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { ListRadiusSessions } from '@application/use-cases/ListRadiusSessions';
import { DisconnectSession } from '@application/use-cases/DisconnectSession';
import { ListRadiusEvents } from '@application/use-cases/ListRadiusEvents';
import { ListNe8000PppoeAudit } from '@application/use-cases/ListNe8000PppoeAudit';

type RequirePerm = (module: RbacModuleCode, action: PermissionAction) => RequestHandler;

/** Valores válidos para los filtros enum de las rutas de auditoría. */
const VALID_EVENT_TYPES    = new Set(['start', 'stop', 'interim']);
const VALID_PPPOE_STATUSES = new Set(['enabled', 'disabled']);
const VALID_ENFORCED       = new Set(['active', 'reduced', 'blocked']);

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
 * Sesiones RADIUS + Auditoría de red.
 *
 * `network.read`:   GET /sessions, GET /events, GET /ne8000/audit
 * `network.manage`: DELETE /sessions/:id
 */
export function createRadiusRouter(
  authProvider: AuthProvider,
  sessionRepo: SessionRepository | undefined,
  requirePerm: RequirePerm,
  listRadiusSessions: ListRadiusSessions,
  disconnectSession: DisconnectSession,
  listRadiusEvents: ListRadiusEvents,
  listNe8000Audit: ListNe8000PppoeAudit,
): Router {
  const router = Router();
  const auth      = createAuthMiddleware(authProvider, sessionRepo);
  const canRead   = requirePerm('network', 'read');
  const canManage = requirePerm('network', 'manage');

  // ── Sesiones existentes ──────────────────────────────────────────────────────

  router.get('/sessions', auth, canRead, async (_req: Request, res: Response): Promise<void> => {
    const sessions = await listRadiusSessions.execute();
    res.json(sessions);
  });

  router.delete('/sessions/:id', auth, canManage, async (req: Request, res: Response): Promise<void> => {
    const result = await disconnectSession.execute(req.params['id'] as string);
    res.json(result);
  });

  // ── GET /events — Logs RADIUS ────────────────────────────────────────────────
  // FIX4: listRadiusEvents ahora es REQUERIDO (sin ?) — la ruta SIEMPRE se registra.
  // FIX5: validación de inputs numéricos y fechas antes de llamar al use case.
  router.get('/events', auth, canRead, async (req: Request, res: Response): Promise<void> => {
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
  });

  // ── GET /ne8000/audit — Auditoría NE8000 ────────────────────────────────────
  // FIX4: listNe8000Audit ahora es REQUERIDO (sin ?) — la ruta SIEMPRE se registra.
  // FIX5: validación de inputs numéricos antes de llamar al use case.
  router.get('/ne8000/audit', auth, canRead, async (req: Request, res: Response): Promise<void> => {
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
  });

  return router;
}
