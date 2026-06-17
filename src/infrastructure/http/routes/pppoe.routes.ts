/**
 * pppoe.routes.ts — rutas HTTP para gestión de PPPoE.
 *
 * Endpoints:
 *   GET    /api/contracts/:contractId/pppoe      pppoe.read
 *   POST   /api/contracts/:contractId/pppoe      pppoe.manage
 *   PATCH  /api/pppoe/:id                         pppoe.manage
 *   POST   /api/pppoe/:id/move                    pppoe.manage
 *   DELETE /api/pppoe/:id                         pppoe.manage  (baja soft)
 *
 * Mapeo de errores:
 *   ROUTER_UNREACHABLE    → 502
 *   PPPOE_USERNAME_TAKEN  → 409
 *   PPPOE_NOT_FOUND       → 404
 *   NAS_NOT_FOUND         → 404
 *   zod invalid           → 422
 */
import { Router, Request, Response, RequestHandler } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { ListPppoeByContract } from '@application/use-cases/ListPppoeByContract';
import { CreatePppoeService } from '@application/use-cases/CreatePppoeService';
import { UpdatePppoeService } from '@application/use-cases/UpdatePppoeService';
import { MovePppoeServiceToRouter } from '@application/use-cases/MovePppoeServiceToRouter';
import { DeactivatePppoeService } from '@application/use-cases/DeactivatePppoeService';
import {
  CreatePppoeBodySchema,
  UpdatePppoeBodySchema,
  MovePppoeBodySchema,
  toPppoeServiceDto,
} from '@application/dto/pppoe.dto';
import {
  RouterUnreachableError,
  PppoeUsernameTakenError,
  PppoeServiceNotFoundError,
  NasNotFoundError,
} from '@domain/errors/pppoe';

type RequirePerm = (module: RbacModuleCode, action: PermissionAction) => RequestHandler;

export function createPppoeRouter(
  authProvider: AuthProvider,
  requirePerm: RequirePerm,
  listPppoeByContract: ListPppoeByContract,
  createPppoeService: CreatePppoeService,
  updatePppoeService: UpdatePppoeService,
  movePppoeServiceToRouter: MovePppoeServiceToRouter,
  deactivatePppoeService: DeactivatePppoeService,
): Router {
  const router = Router();
  const auth     = createAuthMiddleware(authProvider);
  const canRead   = requirePerm('pppoe', 'read');
  const canManage = requirePerm('pppoe', 'manage');

  // ── GET /contracts/:contractId/pppoe ────────────────────────────────────────
  router.get(
    '/contracts/:contractId/pppoe',
    auth,
    canRead,
    async (req: Request, res: Response): Promise<void> => {
      const services = await listPppoeByContract.execute(req.params['contractId'] as string);
      res.json(services.map(toPppoeServiceDto));
    },
  );

  // ── POST /contracts/:contractId/pppoe ───────────────────────────────────────
  router.post(
    '/contracts/:contractId/pppoe',
    auth,
    canManage,
    async (req: Request, res: Response): Promise<void> => {
      const parsed = CreatePppoeBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(422).json({ code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      try {
        const service = await createPppoeService.execute({
          contractId: req.params['contractId'] as string,
          ...parsed.data,
        });
        res.status(201).json(toPppoeServiceDto(service));
      } catch (err) {
        if (err instanceof RouterUnreachableError) {
          res.status(502).json({ code: err.code, error: err.message });
          return;
        }
        if (err instanceof PppoeUsernameTakenError) {
          res.status(409).json({ code: err.code, error: err.message });
          return;
        }
        if (err instanceof NasNotFoundError) {
          res.status(404).json({ code: err.code, error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  // ── PATCH /pppoe/:id ────────────────────────────────────────────────────────
  router.patch(
    '/pppoe/:id',
    auth,
    canManage,
    async (req: Request, res: Response): Promise<void> => {
      const parsed = UpdatePppoeBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(422).json({ code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      try {
        const service = await updatePppoeService.execute({
          id: req.params['id'] as string,
          ...parsed.data,
        });
        res.json(toPppoeServiceDto(service));
      } catch (err) {
        if (err instanceof RouterUnreachableError) {
          res.status(502).json({ code: err.code, error: err.message });
          return;
        }
        if (err instanceof PppoeServiceNotFoundError) {
          res.status(404).json({ code: err.code, error: err.message });
          return;
        }
        if (err instanceof NasNotFoundError) {
          res.status(404).json({ code: err.code, error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  // ── POST /pppoe/:id/move ────────────────────────────────────────────────────
  // Sub-recurso /move montado ANTES de que cualquier catch-all /:id lo sombree.
  router.post(
    '/pppoe/:id/move',
    auth,
    canManage,
    async (req: Request, res: Response): Promise<void> => {
      const parsed = MovePppoeBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(422).json({ code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      try {
        const service = await movePppoeServiceToRouter.execute({
          id: req.params['id'] as string,
          nasId: parsed.data.nasId,
        });
        res.json(toPppoeServiceDto(service));
      } catch (err) {
        if (err instanceof RouterUnreachableError) {
          res.status(502).json({ code: err.code, error: err.message });
          return;
        }
        if (err instanceof PppoeServiceNotFoundError) {
          res.status(404).json({ code: err.code, error: err.message });
          return;
        }
        if (err instanceof NasNotFoundError) {
          res.status(404).json({ code: err.code, error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  // ── DELETE /pppoe/:id ───────────────────────────────────────────────────────
  router.delete(
    '/pppoe/:id',
    auth,
    canManage,
    async (req: Request, res: Response): Promise<void> => {
      try {
        await deactivatePppoeService.execute(req.params['id'] as string);
        res.status(204).send();
      } catch (err) {
        if (err instanceof RouterUnreachableError) {
          res.status(502).json({ code: err.code, error: err.message });
          return;
        }
        if (err instanceof PppoeServiceNotFoundError) {
          res.status(404).json({ code: err.code, error: err.message });
          return;
        }
        if (err instanceof NasNotFoundError) {
          res.status(404).json({ code: err.code, error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  return router;
}
