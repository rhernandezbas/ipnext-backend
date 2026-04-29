import { Router, Request, Response } from 'express';
import { ListOlts } from '@application/use-cases/ListOlts';
import { GetOlt } from '@application/use-cases/GetOlt';
import { CreateOlt } from '@application/use-cases/CreateOlt';
import { ListOnus } from '@application/use-cases/ListOnus';
import { GetOnu } from '@application/use-cases/GetOnu';
import { ListOnusByOlt } from '@application/use-cases/ListOnusByOlt';
import { CreateOnu } from '@application/use-cases/CreateOnu';
import { UpdateOnuStatus } from '@application/use-cases/UpdateOnuStatus';
import { OltDevice, OnuDevice } from '@domain/entities/gpon';

export function createGponRouter(
  listOlts: ListOlts,
  getOlt: GetOlt,
  listOnus: ListOnus,
  getOnu: GetOnu,
  listOnusByOlt: ListOnusByOlt,
  createOlt?: CreateOlt,
  createOnu?: CreateOnu,
  updateOnuStatus?: UpdateOnuStatus,
): Router {
  const router = Router();

  router.get('/olts', async (_req: Request, res: Response): Promise<void> => {
    const olts = await listOlts.execute();
    res.json(olts);
  });

  router.post('/olts', async (req: Request, res: Response): Promise<void> => {
    if (!createOlt) { res.status(501).json({ error: 'Not implemented' }); return; }
    const { name, ip, model, location } = req.body as { name: string; ip: string; model: string; location: string };
    const olt = await createOlt.execute({ name, ipAddress: ip, model, manufacturer: '', uplink: '', ponPorts: 0 } as Omit<OltDevice, 'id' | 'totalOnus' | 'onlineOnus' | 'status' | 'lastSeen'>);
    res.status(201).json(olt);
  });

  router.get('/olts/:id', async (req: Request, res: Response): Promise<void> => {
    const olt = await getOlt.execute(req.params['id'] as string);
    if (!olt) {
      res.status(404).json({ error: 'OLT not found', code: 'OLT_NOT_FOUND' });
      return;
    }
    res.json(olt);
  });

  router.get('/olts/:id/onus', async (req: Request, res: Response): Promise<void> => {
    const onus = await listOnusByOlt.execute(req.params['id'] as string);
    res.json(onus);
  });

  router.post('/onus', async (req: Request, res: Response): Promise<void> => {
    if (!createOnu) { res.status(501).json({ error: 'Not implemented' }); return; }
    const { serial, model, oltId, port, customerId, customerName } = req.body as {
      serial: string; model: string; oltId: number; port: number;
      customerId?: number; customerName?: string;
    };
    const onu = await createOnu.execute({
      serialNumber: serial,
      model,
      oltId: String(oltId),
      ponPort: port,
      clientId: customerId ? String(customerId) : null,
      clientName: customerName ?? null,
    } as Omit<OnuDevice, 'id' | 'oltName' | 'onuId' | 'rxPower' | 'txPower' | 'distance' | 'firmwareVersion' | 'lastSeen' | 'status'>);
    res.status(201).json(onu);
  });

  router.get('/onus', async (req: Request, res: Response): Promise<void> => {
    const { oltId } = req.query as { oltId?: string };
    if (oltId) {
      const onus = await listOnusByOlt.execute(oltId);
      res.json(onus);
      return;
    }
    const onus = await listOnus.execute();
    res.json(onus);
  });

  router.get('/onus/:id', async (req: Request, res: Response): Promise<void> => {
    const onu = await getOnu.execute(req.params['id'] as string);
    if (!onu) {
      res.status(404).json({ error: 'ONU not found', code: 'ONU_NOT_FOUND' });
      return;
    }
    res.json(onu);
  });

  router.patch('/onus/:id/status', async (req: Request, res: Response): Promise<void> => {
    if (!updateOnuStatus) { res.status(501).json({ error: 'Not implemented' }); return; }
    const { status } = req.body as { status: OnuDevice['status'] };
    const onu = await updateOnuStatus.execute(req.params['id'] as string, status);
    if (!onu) {
      res.status(404).json({ error: 'ONU not found', code: 'ONU_NOT_FOUND' });
      return;
    }
    res.json(onu);
  });

  return router;
}
