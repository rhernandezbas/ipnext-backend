import { Router, Request, Response, NextFunction } from 'express';
import { ListUbicaciones } from '@application/use-cases/ListUbicaciones';
import { GetUbicacion } from '@application/use-cases/GetUbicacion';
import { CreateUbicacion } from '@application/use-cases/CreateUbicacion';
import { UpdateUbicacion } from '@application/use-cases/UpdateUbicacion';
import { DeleteUbicacion } from '@application/use-cases/DeleteUbicacion';
import { Ubicacion } from '@domain/entities/ubicacion';

export function createUbicacionesRouter(
  listUbicaciones: ListUbicaciones,
  getUbicacion: GetUbicacion,
  createUbicacion: CreateUbicacion,
  updateUbicacion: UpdateUbicacion,
  deleteUbicacion: DeleteUbicacion,
): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ubicaciones = await listUbicaciones.execute();
      res.json(ubicaciones);
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ubicacion = await getUbicacion.execute(req.params['id'] as string);
      if (!ubicacion) {
        res.status(404).json({ error: 'Location not found', code: 'LOCATION_NOT_FOUND' });
        return;
      }
      res.json(ubicacion);
    } catch (err) {
      next(err);
    }
  });

  router.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const data = req.body as Omit<Ubicacion, 'id'>;
      const ubicacion = await createUbicacion.execute(data);
      res.status(201).json(ubicacion);
    } catch (err) {
      next(err);
    }
  });

  router.put('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ubicacion = await updateUbicacion.execute(req.params['id'] as string, req.body as Partial<Ubicacion>);
      if (!ubicacion) {
        res.status(404).json({ error: 'Location not found', code: 'LOCATION_NOT_FOUND' });
        return;
      }
      res.json(ubicacion);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const deleted = await deleteUbicacion.execute(req.params['id'] as string);
      if (!deleted) {
        res.status(404).json({ error: 'Location not found', code: 'LOCATION_NOT_FOUND' });
        return;
      }
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
