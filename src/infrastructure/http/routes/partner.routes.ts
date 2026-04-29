import { Router, Request, Response } from 'express';
import { ListPartners } from '@application/use-cases/ListPartners';
import { GetPartner } from '@application/use-cases/GetPartner';
import { CreatePartner } from '@application/use-cases/CreatePartner';
import { UpdatePartner } from '@application/use-cases/UpdatePartner';
import { DeletePartner } from '@application/use-cases/DeletePartner';
import { Partner } from '@domain/entities/partner';

export function createPartnerRouter(
  listPartners: ListPartners,
  getPartner: GetPartner,
  createPartner: CreatePartner,
  updatePartner: UpdatePartner,
  deletePartner: DeletePartner,
): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response): Promise<void> => {
    const partners = await listPartners.execute();
    res.json(partners);
  });

  router.get('/:id', async (req: Request, res: Response): Promise<void> => {
    const partner = await getPartner.execute(req.params['id'] as string);
    if (!partner) {
      res.status(404).json({ error: 'Partner not found', code: 'PARTNER_NOT_FOUND' });
      return;
    }
    res.json(partner);
  });

  router.post('/', async (req: Request, res: Response): Promise<void> => {
    const data = req.body as Omit<Partner, 'id' | 'createdAt' | 'clientCount' | 'adminCount'>;
    const partner = await createPartner.execute(data);
    res.status(201).json(partner);
  });

  router.put('/:id', async (req: Request, res: Response): Promise<void> => {
    const partner = await updatePartner.execute(req.params['id'] as string, req.body as Partial<Partner>);
    if (!partner) {
      res.status(404).json({ error: 'Partner not found', code: 'PARTNER_NOT_FOUND' });
      return;
    }
    res.json(partner);
  });

  router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
    const deleted = await deletePartner.execute(req.params['id'] as string);
    if (!deleted) {
      res.status(404).json({ error: 'Partner not found', code: 'PARTNER_NOT_FOUND' });
      return;
    }
    res.status(204).send();
  });

  return router;
}
