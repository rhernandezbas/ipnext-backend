import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import type { SessionRepository } from '@domain/ports/SessionRepository';

import { ListPortalPromosAdmin } from '@application/use-cases/promos/ListPortalPromosAdmin';
import { GetPortalPromoAdmin } from '@application/use-cases/promos/GetPortalPromoAdmin';
import { CreatePortalPromo } from '@application/use-cases/promos/CreatePortalPromo';
import { UpdatePortalPromo } from '@application/use-cases/promos/UpdatePortalPromo';
import { PreviewPromoAudience } from '@application/use-cases/promos/PreviewPromoAudience';

import { CreatePortalPromoSchema, UpdatePortalPromoSchema, parsePromoSegment } from '@application/dto/promos.dto';
import { PortalPromoNotFoundError, PortalPromoValidationError } from '@domain/errors/portalPromo.errors';

/** Factory matching `requirePerm` exported from app.ts (DIP-clean injection). */
type RequirePerm = (module: RbacModuleCode, action: PermissionAction) => RequestHandler;

/**
 * `/api/promos` — factory calco de `createNewsRouter`/`createTicketAreasRouter`.
 * Auth + `requirePerm` en TODAS las rutas — `promos.read` para lectura,
 * `promos.manage` para create/update. `audience-preview` exige `promos.manage`
 * (es una herramienta de armado de campaña, no de lectura pasiva).
 */
export function createPromosRouter(
  authProvider: AuthProvider,
  sessionRepo: SessionRepository | undefined,
  requirePerm: RequirePerm,
  listPortalPromosAdmin: ListPortalPromosAdmin,
  getPortalPromoAdmin: GetPortalPromoAdmin,
  createPortalPromo: CreatePortalPromo,
  updatePortalPromo: UpdatePortalPromo,
  previewPromoAudience: PreviewPromoAudience,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider, sessionRepo);
  const readPerm = requirePerm('promos', 'read');
  const managePerm = requirePerm('promos', 'manage');

  router.get('/', auth, readPerm, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.json({ data: await listPortalPromosAdmin.execute() });
    } catch (err) {
      next(err);
    }
  });

  // audience-preview — ESTÁTICA, debe preceder a `/:id`.
  router.post(
    '/audience-preview',
    auth,
    managePerm,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const segment = parsePromoSegment(body['segment'] ?? body);
        res.json(await previewPromoAudience.execute(segment));
      } catch (err) {
        if (err instanceof PortalPromoValidationError) {
          res.status(400).json({ error: err.message, code: err.code });
          return;
        }
        next(err);
      }
    },
  );

  router.post('/', auth, managePerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = CreatePortalPromoSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      const segment = parsePromoSegment((req.body as Record<string, unknown> | undefined)?.['segment']);
      const dto = await createPortalPromo.execute(
        { ...parsed.data, segment },
        req.user?.id ?? null,
        req.user?.username ?? 'Sistema',
      );
      res.status(201).json(dto);
    } catch (err) {
      if (err instanceof PortalPromoValidationError) {
        res.status(400).json({ error: err.message, code: err.code });
        return;
      }
      next(err);
    }
  });

  // ─── /:id routes — declared LAST (catch-all param) ─────────────────────────
  router.get('/:id', auth, readPerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.json(await getPortalPromoAdmin.execute(req.params['id'] as string));
    } catch (err) {
      if (err instanceof PortalPromoNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      next(err);
    }
  });

  router.patch('/:id', auth, managePerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = UpdatePortalPromoSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      const rawBody = req.body as Record<string, unknown> | undefined;
      const patch = {
        ...parsed.data,
        ...(rawBody && 'segment' in rawBody ? { segment: parsePromoSegment(rawBody['segment']) } : {}),
      };
      const dto = await updatePortalPromo.execute(req.params['id'] as string, patch);
      res.json(dto);
    } catch (err) {
      if (err instanceof PortalPromoNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof PortalPromoValidationError) {
        res.status(400).json({ error: err.message, code: err.code });
        return;
      }
      next(err);
    }
  });

  return router;
}
