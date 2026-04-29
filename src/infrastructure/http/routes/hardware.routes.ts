import { Router, Request, Response } from 'express';
import { ListHardwareAssets } from '@application/use-cases/ListHardwareAssets';
import { CreateHardwareAsset } from '@application/use-cases/CreateHardwareAsset';
import { UpdateHardwareAsset } from '@application/use-cases/UpdateHardwareAsset';
import { DeleteHardwareAsset } from '@application/use-cases/DeleteHardwareAsset';

export function createHardwareRouter(
  listHardwareAssets: ListHardwareAssets,
  createHardwareAsset: CreateHardwareAsset,
  updateHardwareAsset: UpdateHardwareAsset,
  deleteHardwareAsset: DeleteHardwareAsset,
): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response): Promise<void> => {
    const assets = await listHardwareAssets.execute();
    res.json(assets);
  });

  router.post('/', async (req: Request, res: Response): Promise<void> => {
    const asset = await createHardwareAsset.execute(req.body);
    res.status(201).json(asset);
  });

  router.put('/:id', async (req: Request, res: Response): Promise<void> => {
    const asset = await updateHardwareAsset.execute(req.params['id'] as string, req.body);
    if (!asset) {
      res.status(404).json({ error: 'Hardware asset not found', code: 'HARDWARE_NOT_FOUND' });
      return;
    }
    res.json(asset);
  });

  router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
    const deleted = await deleteHardwareAsset.execute(req.params['id'] as string);
    if (!deleted) {
      res.status(404).json({ error: 'Hardware asset not found', code: 'HARDWARE_NOT_FOUND' });
      return;
    }
    res.status(204).send();
  });

  return router;
}
