import { Router, Request, Response } from 'express';
import { ListNasServers } from '@application/use-cases/ListNasServers';
import { GetNasServer } from '@application/use-cases/GetNasServer';
import { CreateNasServer } from '@application/use-cases/CreateNasServer';
import { UpdateNasServer } from '@application/use-cases/UpdateNasServer';
import { DeleteNasServer } from '@application/use-cases/DeleteNasServer';
import { GetRadiusConfig } from '@application/use-cases/GetRadiusConfig';
import { UpdateRadiusConfig } from '@application/use-cases/UpdateRadiusConfig';

export function createNasRouter(
  listNasServers: ListNasServers,
  getNasServer: GetNasServer,
  createNasServer: CreateNasServer,
  updateNasServer: UpdateNasServer,
  deleteNasServer: DeleteNasServer,
  getRadiusConfig: GetRadiusConfig,
  updateRadiusConfig: UpdateRadiusConfig,
): Router {
  const router = Router();

  // NAS Servers
  router.get('/nas-servers', async (_req: Request, res: Response): Promise<void> => {
    const servers = await listNasServers.execute();
    res.json(servers);
  });

  router.post('/nas-servers', async (req: Request, res: Response): Promise<void> => {
    const server = await createNasServer.execute(req.body);
    res.status(201).json(server);
  });

  router.get('/nas-servers/:id', async (req: Request, res: Response): Promise<void> => {
    const server = await getNasServer.execute(req.params['id'] as string);
    if (!server) {
      res.status(404).json({ error: 'NAS server not found', code: 'NAS_SERVER_NOT_FOUND' });
      return;
    }
    res.json(server);
  });

  router.put('/nas-servers/:id', async (req: Request, res: Response): Promise<void> => {
    const server = await updateNasServer.execute(req.params['id'] as string, req.body);
    if (!server) {
      res.status(404).json({ error: 'NAS server not found', code: 'NAS_SERVER_NOT_FOUND' });
      return;
    }
    res.json(server);
  });

  router.delete('/nas-servers/:id', async (req: Request, res: Response): Promise<void> => {
    const deleted = await deleteNasServer.execute(req.params['id'] as string);
    if (!deleted) {
      res.status(404).json({ error: 'NAS server not found', code: 'NAS_SERVER_NOT_FOUND' });
      return;
    }
    res.status(204).send();
  });

  // Radius Config
  router.get('/radius-config', async (_req: Request, res: Response): Promise<void> => {
    const config = await getRadiusConfig.execute();
    res.json(config);
  });

  router.put('/radius-config', async (req: Request, res: Response): Promise<void> => {
    const config = await updateRadiusConfig.execute(req.body);
    res.json(config);
  });

  return router;
}
