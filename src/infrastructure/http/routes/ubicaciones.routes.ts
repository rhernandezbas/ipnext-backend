import { Router, Request, Response } from 'express';
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

  router.get('/', async (_req: Request, res: Response): Promise<void> => {
    const ubicaciones = await listUbicaciones.execute();
    res.json(ubicaciones);
  });

  router.get('/:id', async (req: Request, res: Response): Promise<void> => {
    const ubicacion = await getUbicacion.execute(req.params['id'] as string);
    if (!ubicacion) {
      res.status(404).json({ error: 'Location not found', code: 'LOCATION_NOT_FOUND' });
      return;
    }
    res.json(ubicacion);
  });

  router.post('/', async (req: Request, res: Response): Promise<void> => {
    const data = req.body as Omit<Ubicacion, 'id'>;
    const ubicacion = await createUbicacion.execute(data);
    res.status(201).json(ubicacion);
  });

  router.put('/:id', async (req: Request, res: Response): Promise<void> => {
    const ubicacion = await updateUbicacion.execute(req.params['id'] as string, req.body as Partial<Ubicacion>);
    if (!ubicacion) {
      res.status(404).json({ error: 'Location not found', code: 'LOCATION_NOT_FOUND' });
      return;
    }
    res.json(ubicacion);
  });

  router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
    const deleted = await deleteUbicacion.execute(req.params['id'] as string);
    if (!deleted) {
      res.status(404).json({ error: 'Location not found', code: 'LOCATION_NOT_FOUND' });
      return;
    }
    res.status(204).send();
  });

  return router;
}
