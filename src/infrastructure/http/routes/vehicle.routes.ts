import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { CreateVehicle } from '@application/use-cases/CreateVehicle';
import { UpdateVehicle } from '@application/use-cases/UpdateVehicle';
import { DeleteVehicle } from '@application/use-cases/DeleteVehicle';
import { ListVehicles } from '@application/use-cases/ListVehicles';
import { GetVehicle } from '@application/use-cases/GetVehicle';
import {
  VehicleNotFoundError,
  DuplicatePlateError,
  VehicleInUseError,
} from '@domain/errors/inventory';
import { z } from 'zod';

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const CreateVehicleSchema = z.object({
  plate: z.string().min(1),
  name: z.string().nullish(),
  assignedTechnicianId: z.string().nullish(),
});

const UpdateVehicleSchema = z.object({
  plate: z.string().min(1).optional(),
  name: z.string().nullable().optional(),
  assignedTechnicianId: z.string().nullable().optional(),
  status: z.enum(['active', 'inactive']).optional(),
}).strict();

// ─── Error handler ────────────────────────────────────────────────────────────

function handleVehicleError(e: unknown, res: Response, next: NextFunction): void {
  if (e instanceof VehicleNotFoundError) {
    res.status(404).json({ error: e.message, code: e.code });
    return;
  }
  if (e instanceof DuplicatePlateError) {
    res.status(409).json({ error: e.message, code: e.code });
    return;
  }
  if (e instanceof VehicleInUseError) {
    res.status(409).json({ error: e.message, code: e.code });
    return;
  }
  // P2002 race on unique plate index (create or update): map to 409 with the
  // same code DuplicatePlateError emits so the FE reads one consistent code.
  if (e && typeof e === 'object' && (e as { code?: string }).code === 'P2002') {
    res.status(409).json({ error: 'A vehicle with that plate already exists', code: 'VEHICLE_PLATE_CONFLICT' });
    return;
  }
  next(e);
}

// ─── Router factory ───────────────────────────────────────────────────────────

/**
 * Vehicle catalog CRUD surface (EPIC #38, Wave 5b). Mounted at `/api/vehicles`.
 *
 * - GET  /          → list (inventory.read)
 * - POST /          → create (inventory.manage)
 * - PATCH /:id      → update (inventory.manage)
 * - DELETE /:id     → guarded delete (inventory.manage)
 */
export function createVehicleRouter(
  listVehicles: ListVehicles,
  getVehicle: GetVehicle,
  createVehicle: CreateVehicle,
  updateVehicle: UpdateVehicle,
  deleteVehicle: DeleteVehicle,
  auth: RequestHandler,
  requireRead: RequestHandler,
  requireManage: RequestHandler,
): Router {
  const router = Router();

  // GET / — list all vehicles (inventory.read)
  router.get('/', auth, requireRead, async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const vehicles = await listVehicles.execute();
      res.json(vehicles);
    } catch (e) {
      next(e);
    }
  });

  // GET /:id — get one vehicle (inventory.read)
  router.get('/:id', auth, requireRead, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const vehicle = await getVehicle.execute(req.params.id);
      res.json(vehicle);
    } catch (e) {
      handleVehicleError(e, res, next);
    }
  });

  // POST / — create vehicle (inventory.manage)
  router.post('/', auth, requireManage, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = CreateVehicleSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      const vehicle = await createVehicle.execute({
        plate: parsed.data.plate,
        name: parsed.data.name ?? null,
        assignedTechnicianId: parsed.data.assignedTechnicianId ?? null,
      });
      res.status(201).json(vehicle);
    } catch (e) {
      handleVehicleError(e, res, next);
    }
  });

  // PATCH /:id — update vehicle (inventory.manage)
  router.patch('/:id', auth, requireManage, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = UpdateVehicleSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      const vehicle = await updateVehicle.execute(req.params.id, parsed.data);
      res.json(vehicle);
    } catch (e) {
      handleVehicleError(e, res, next);
    }
  });

  // DELETE /:id — guarded delete (inventory.manage)
  router.delete('/:id', auth, requireManage, async (req: Request, res: Response, next: NextFunction) => {
    try {
      await deleteVehicle.execute(req.params.id);
      res.status(204).send();
    } catch (e) {
      handleVehicleError(e, res, next);
    }
  });

  return router;
}
