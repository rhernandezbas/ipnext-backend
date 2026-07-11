import { Router, Request, Response, NextFunction } from 'express';
import { ListProformas } from '@application/use-cases/ListProformas';
import { CreateProforma } from '@application/use-cases/CreateProforma';
import { ConvertToInvoice } from '@application/use-cases/ConvertToInvoice';
import { CancelProforma } from '@application/use-cases/CancelProforma';

export function createProformasRouter(
  listProformas: ListProformas,
  createProforma: CreateProforma,
  convertToInvoice: ConvertToInvoice,
  cancelProforma: CancelProforma,
): Router {
  const router = Router();

  router.get('/proformas', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const proformas = await listProformas.execute();
      res.json(proformas);
    } catch (err) {
      next(err);
    }
  });

  router.post('/proformas', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const proforma = await createProforma.execute(req.body);
      res.status(201).json(proforma);
    } catch (err) {
      next(err);
    }
  });

  router.post('/proformas/:id/convert', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { invoiceId } = req.body as { invoiceId: string };
      const proforma = await convertToInvoice.execute(req.params['id'] as string, invoiceId ?? 'new');
      if (!proforma) {
        res.status(404).json({ error: 'Proforma not found', code: 'PROFORMA_NOT_FOUND' });
        return;
      }
      res.json(proforma);
    } catch (err) {
      next(err);
    }
  });

  router.post('/proformas/:id/cancel', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const proforma = await cancelProforma.execute(req.params['id'] as string);
      if (!proforma) {
        res.status(404).json({ error: 'Proforma not found', code: 'PROFORMA_NOT_FOUND' });
        return;
      }
      res.json(proforma);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
