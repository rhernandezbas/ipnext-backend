import { Router, Request, Response } from 'express';
import { ListRadiusSessions } from '@application/use-cases/ListRadiusSessions';
import { DisconnectSession } from '@application/use-cases/DisconnectSession';

export function createRadiusRouter(
  listRadiusSessions: ListRadiusSessions,
  disconnectSession: DisconnectSession,
): Router {
  const router = Router();

  router.get('/sessions', async (_req: Request, res: Response): Promise<void> => {
    const sessions = await listRadiusSessions.execute();
    res.json(sessions);
  });

  router.delete('/sessions/:id', async (req: Request, res: Response): Promise<void> => {
    const result = await disconnectSession.execute(req.params['id'] as string);
    res.json(result);
  });

  return router;
}
