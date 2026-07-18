/**
 * conversation-events (Ola 2) — /api/messaging/reports router. Endpoints de AGREGACIÓN que
 * consume el dashboard de Ola 3 (NO construye el dashboard, sólo los cimientos). Router
 * SEPARADO (mismo patrón que messagingBulk.routes / templates.routes): se monta en
 * `/api/messaging/reports` DESPUÉS del router principal, que no matchea `/reports/*` y cae a
 * este (igual que `/bulk`). Todo gateado por `auth` + `messaging:read` (mismo guard que el
 * listado — reporta sobre lo mismo que el inbox muestra).
 *
 * from/to: instantes UTC (ISO-8601). Rango SEMI-ABIERTO `[from, to)`. Faltantes o no
 * parseables → 400 VALIDATION_ERROR. El FE calcula los bordes (ej. inicio/fin de día AR en
 * UTC). El BUCKETING por día/hora se hace en zona AR (ver DTOs / reportsTimezone).
 */
import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import type { GetReportsOverview } from '@application/use-cases/messaging/GetReportsOverview';
import type { GetTrafficReport } from '@application/use-cases/messaging/GetTrafficReport';
import type { GetResolutionsReport } from '@application/use-cases/messaging/GetResolutionsReport';

/** Toma el primer valor de un query param (Express tipa claves repetidas como string[]). */
function firstQueryValue(v: unknown): string | undefined {
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : undefined;
  return typeof v === 'string' ? v : undefined;
}

/**
 * Valida `from`/`to`: ambos presentes y parseables a fecha. Devuelve los instantes
 * NORMALIZADOS a ISO-8601 (canónico) o `null` si el input es inválido (→ 400 en la route).
 * NO exige `from < to` (un rango vacío es válido: devuelve ceros/lista vacía, no un error).
 */
function parseRange(req: Request): { fromIso: string; toIso: string } | null {
  const fromRaw = firstQueryValue(req.query['from']);
  const toRaw = firstQueryValue(req.query['to']);
  if (!fromRaw || !toRaw) return null;
  const from = new Date(fromRaw);
  const to = new Date(toRaw);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  return { fromIso: from.toISOString(), toIso: to.toISOString() };
}

const INVALID_RANGE = {
  error: 'from and to are required and must be valid ISO-8601 timestamps',
  code: 'VALIDATION_ERROR',
} as const;

export interface MessagingReportsRoutePerms {
  read: RequestHandler;
}

export function createMessagingReportsRouter(
  getReportsOverview: GetReportsOverview,
  getTrafficReport: GetTrafficReport,
  getResolutionsReport: GetResolutionsReport,
  auth: RequestHandler,
  perms: MessagingReportsRoutePerms,
): Router {
  const router = Router();

  // ─── GET /reports/overview (read) — tiles del dashboard ─────────────────────
  router.get(
    '/overview',
    auth,
    perms.read,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const range = parseRange(req);
        if (!range) {
          res.status(400).json(INVALID_RANGE);
          return;
        }
        // `mine` de GetInboxViewCounts se resuelve del user autenticado (req.user.id) — el
        // overview no lo usa, pero se pasa el user real igual (mismo patrón que /conversations/counts).
        const result = await getReportsOverview.execute(req.user?.id as string, range.fromIso, range.toIso);
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── GET /reports/traffic (read) — heatmap inbound por día×hora (zona AR) ────
  router.get(
    '/traffic',
    auth,
    perms.read,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const range = parseRange(req);
        if (!range) {
          res.status(400).json(INVALID_RANGE);
          return;
        }
        const result = await getTrafficReport.execute(range.fromIso, range.toIso);
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── GET /reports/resolutions (read) — resoluciones por día (zona AR) ────────
  router.get(
    '/resolutions',
    auth,
    perms.read,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const range = parseRange(req);
        if (!range) {
          res.status(400).json(INVALID_RANGE);
          return;
        }
        const result = await getResolutionsReport.execute(range.fromIso, range.toIso);
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
