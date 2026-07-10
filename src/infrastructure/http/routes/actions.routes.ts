/**
 * actions-worklist W2 — /api/actions (worklist de titularidad + bajas recientes).
 * Patrón recapture.routes.ts: factory + perms interface por ruta + auth en el mount.
 * Handlers async SIEMPRE con try/catch + next(err) (lección 504) — los errores de
 * dominio tipados los mapea el errorHandler global vía statusMap (fuente única).
 */
import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { ListOwnershipCases } from '@application/use-cases/actions/ListOwnershipCases';
import { UpdateOwnershipCase, UpdateOwnershipCaseAction } from '@application/use-cases/actions/UpdateOwnershipCase';
import { ListRecentBajas } from '@application/use-cases/actions/ListRecentBajas';
import type { OwnershipCaseStatus } from '@domain/entities/ownershipCase';

/** Per-route permission guards (actions read/manage). */
export interface ActionsRoutePerms {
  read: RequestHandler;
  manage: RequestHandler;
}

const VALID_CASE_STATUSES: OwnershipCaseStatus[] = ['pending', 'ambiguous', 'done', 'dismissed'];

/** Estados aceptados por el PATCH — `done` NUNCA se setea a mano (lo computa el List). */
const PATCHABLE_STATUSES = ['dismissed', 'pending'] as const;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Parsea el body union del PATCH. Devuelve la acción tipada o un mensaje de
 * error de validación (→ 400 sin efectos).
 */
function parsePatchBody(body: Record<string, unknown>): UpdateOwnershipCaseAction | { error: string } {
  const discriminators = ['equipmentReviewed', 'targetContractId', 'status'].filter((k) => k in body);

  if (discriminators.length !== 1) {
    return { error: 'Body must contain exactly one of: equipmentReviewed, targetContractId, status' };
  }

  if ('equipmentReviewed' in body) {
    if (typeof body['equipmentReviewed'] !== 'boolean') {
      return { error: 'equipmentReviewed must be a boolean' };
    }
    return { kind: 'equipmentReviewed', reviewed: body['equipmentReviewed'] };
  }

  if ('targetContractId' in body) {
    const target = body['targetContractId'];
    if (typeof target !== 'string' || target.trim() === '') {
      return { error: 'targetContractId must be a non-empty string' };
    }
    return { kind: 'pickTarget', targetContractId: target };
  }

  const status = body['status'];
  if (typeof status !== 'string' || !(PATCHABLE_STATUSES as readonly string[]).includes(status)) {
    return { error: `status must be one of: ${PATCHABLE_STATUSES.join(', ')}` };
  }

  if (status === 'dismissed') {
    const reason = body['reason'];
    if (reason !== undefined && typeof reason !== 'string') {
      return { error: 'reason must be a string' };
    }
    // reason ausente/blanco → el use case lanza DismissReasonRequiredError (400 sin efectos)
    return { kind: 'dismiss', reason: (reason as string | undefined) ?? '' };
  }

  return { kind: 'reopen' };
}

export function createActionsRouter(
  listOwnershipCases: ListOwnershipCases,
  updateOwnershipCase: UpdateOwnershipCase,
  listRecentBajas: ListRecentBajas,
  auth: RequestHandler,
  perms: ActionsRoutePerms,
): Router {
  const router = Router();

  // ─── GET /ownership-cases (read) ─────────────────────────────────────────────
  router.get(
    '/ownership-cases',
    auth,
    perms.read,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { status, page, pageSize } = req.query as Record<string, string | undefined>;

        if (status !== undefined && !VALID_CASE_STATUSES.includes(status as OwnershipCaseStatus)) {
          res.status(400).json({ error: `Invalid status: "${status}"`, code: 'VALIDATION_ERROR' });
          return;
        }

        const result = await listOwnershipCases.execute({
          status: status as OwnershipCaseStatus | undefined,
          page: parsePositiveInt(page, 1),
          pageSize: parsePositiveInt(pageSize, 25),
        });
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── PATCH /ownership-cases/:id (manage) ─────────────────────────────────────
  router.patch(
    '/ownership-cases/:id',
    auth,
    perms.manage,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const action = parsePatchBody(req.body as Record<string, unknown>);
        if ('error' in action) {
          res.status(400).json({ error: action.error, code: 'VALIDATION_ERROR' });
          return;
        }

        // Fail-closed: el check manual necesita el actor para el rastro.
        const actorId = (req.user?.id as string | undefined) ?? '';
        if (action.kind === 'equipmentReviewed' && action.reviewed && !actorId) {
          res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
          return;
        }

        const updated = await updateOwnershipCase.execute(req.params['id'] as string, actorId, action);
        res.json(updated);
      } catch (err) {
        // OWNERSHIP_CASE_NOT_FOUND → 404 · INVALID_CANDIDATE_PICK / INVALID_CASE_TRANSITION → 422 ·
        // DISMISS_REASON_REQUIRED → 400 — mapeados por el errorHandler global (statusMap).
        next(err);
      }
    },
  );

  // ─── GET /recent-bajas (read) ────────────────────────────────────────────────
  router.get(
    '/recent-bajas',
    auth,
    perms.read,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { page, pageSize } = req.query as Record<string, string | undefined>;
        const result = await listRecentBajas.execute({
          page: parsePositiveInt(page, 1),
          pageSize: parsePositiveInt(pageSize, 25),
        });
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
