/**
 * zones.routes.ts — rutas HTTP para gestión de zonas visuales.
 *
 * Endpoints:
 *   GET    /api/zones        zones.read    — lista todas las zonas
 *   POST   /api/zones        zones.manage  — crea una zona
 *   GET    /api/zones/:id    zones.read    — devuelve una zona
 *   PUT    /api/zones/:id    zones.manage  — actualiza una zona
 *   DELETE /api/zones/:id    zones.manage  — elimina una zona
 *
 * Mapeo de errores:
 *   ZONE_NOT_FOUND   → 404
 *   INVALID_POLYGON  → 422
 */
import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import type { SessionRepository } from '@domain/ports/SessionRepository';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { ZoneNotFoundError, InvalidPolygonError } from '@domain/errors/zone';
import { ListZones } from '@application/use-cases/ListZones';
import { CreateZone } from '@application/use-cases/CreateZone';
import { GetZone } from '@application/use-cases/GetZone';
import { UpdateZone } from '@application/use-cases/UpdateZone';
import { DeleteZone } from '@application/use-cases/DeleteZone';
import { z } from 'zod';

const ZonePointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const CreateZoneBodySchema = z.object({
  name: z.string().min(1),
  color: z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/),
  points: z.array(ZonePointSchema).min(3),
  description: z.string().nullable().optional(),
});

const UpdateZoneBodySchema = z.object({
  name: z.string().min(1).optional(),
  color: z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/).optional(),
  points: z.array(ZonePointSchema).min(3).optional(),
  description: z.string().nullable().optional(),
}).refine(
  data => Object.keys(data).length > 0,
  { message: 'At least one field must be provided for update' },
);

type RequirePerm = (module: RbacModuleCode, action: PermissionAction) => RequestHandler;

export function createZonesRouter(
  authProvider: AuthProvider,
  sessionRepo: SessionRepository | undefined,
  requirePerm: RequirePerm,
  listZones: ListZones,
  createZone: CreateZone,
  getZone: GetZone,
  updateZone: UpdateZone,
  deleteZone: DeleteZone,
): Router {
  const router = Router();
  const auth      = createAuthMiddleware(authProvider, sessionRepo);
  const canRead   = requirePerm('zones', 'read');
  const canManage = requirePerm('zones', 'manage');

  // ── GET /zones ──────────────────────────────────────────────────────────────
  router.get('/zones', auth, canRead, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const zones = await listZones.execute();
      res.json(zones);
    } catch (err) {
      next(err);
    }
  });

  // ── POST /zones ─────────────────────────────────────────────────────────────
  router.post('/zones', auth, canManage, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = CreateZoneBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({ code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      const dto = await createZone.execute(parsed.data);
      res.status(201).json(dto);
    } catch (err) {
      if (err instanceof InvalidPolygonError) {
        res.status(422).json({ code: err.code, error: err.message });
        return;
      }
      next(err);
    }
  });

  // ── GET /zones/:id ──────────────────────────────────────────────────────────
  router.get('/zones/:id', auth, canRead, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const dto = await getZone.execute(req.params['id'] as string);
      res.json(dto);
    } catch (err) {
      if (err instanceof ZoneNotFoundError) {
        res.status(404).json({ code: err.code, error: err.message });
        return;
      }
      next(err);
    }
  });

  // ── PUT /zones/:id ──────────────────────────────────────────────────────────
  router.put('/zones/:id', auth, canManage, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = UpdateZoneBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({ code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      const dto = await updateZone.execute({ id: req.params['id'] as string, ...parsed.data });
      res.json(dto);
    } catch (err) {
      if (err instanceof ZoneNotFoundError) {
        res.status(404).json({ code: err.code, error: err.message });
        return;
      }
      if (err instanceof InvalidPolygonError) {
        res.status(422).json({ code: err.code, error: err.message });
        return;
      }
      next(err);
    }
  });

  // ── DELETE /zones/:id ───────────────────────────────────────────────────────
  router.delete('/zones/:id', auth, canManage, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await deleteZone.execute(req.params['id'] as string);
      res.status(204).send();
    } catch (err) {
      if (err instanceof ZoneNotFoundError) {
        res.status(404).json({ code: err.code, error: err.message });
        return;
      }
      next(err);
    }
  });

  return router;
}
