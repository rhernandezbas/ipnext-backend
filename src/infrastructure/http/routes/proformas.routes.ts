import { Router, Request, Response } from 'express';
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

  router.get('/proformas', async (_req: Request, res: Response): Promise<void> => {
    const proformas = await listProformas.execute();
    res.json(proformas);
  });

  router.post('/proformas', async (req: Request, res: Response): Promise<void> => {
    const proforma = await createProforma.execute(req.body);
    res.status(201).json(proforma);
  });

  router.post('/proformas/:id/convert', async (req: Request, res: Response): Promise<void> => {
    const { invoiceId } = req.body as { invoiceId: string };
    const proforma = await convertToInvoice.execute(req.params['id'] as string, invoiceId ?? 'new');
    if (!proforma) {
      res.status(404).json({ error: 'Proforma not found', code: 'PROFORMA_NOT_FOUND' });
      return;
    }
    res.json(proforma);
  });

  router.post('/proformas/:id/cancel', async (req: Request, res: Response): Promise<void> => {
    const proforma = await cancelProforma.execute(req.params['id'] as string);
    if (!proforma) {
      res.status(404).json({ error: 'Proforma not found', code: 'PROFORMA_NOT_FOUND' });
      return;
    }
    res.json(proforma);
  });

  return router;
}
