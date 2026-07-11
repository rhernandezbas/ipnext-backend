import { Router, Request, Response, NextFunction } from 'express';
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

  router.get('/', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const partners = await listPartners.execute();
      res.json(partners);
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const partner = await getPartner.execute(req.params['id'] as string);
      if (!partner) {
        res.status(404).json({ error: 'Partner not found', code: 'PARTNER_NOT_FOUND' });
        return;
      }
      res.json(partner);
    } catch (err) {
      next(err);
    }
  });

  router.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const data = req.body as Omit<Partner, 'id' | 'createdAt' | 'clientCount' | 'adminCount'>;
      const partner = await createPartner.execute(data);
      res.status(201).json(partner);
    } catch (err) {
      next(err);
    }
  });

  router.put('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const partner = await updatePartner.execute(req.params['id'] as string, req.body as Partial<Partner>);
      if (!partner) {
        res.status(404).json({ error: 'Partner not found', code: 'PARTNER_NOT_FOUND' });
        return;
      }
      res.json(partner);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const deleted = await deletePartner.execute(req.params['id'] as string);
      if (!deleted) {
        res.status(404).json({ error: 'Partner not found', code: 'PARTNER_NOT_FOUND' });
        return;
      }
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
