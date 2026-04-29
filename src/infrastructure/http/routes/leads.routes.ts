import { Router, Request, Response } from 'express';
import { ListLeads } from '@application/use-cases/ListLeads';
import { GetLead } from '@application/use-cases/GetLead';
import { CreateLead } from '@application/use-cases/CreateLead';
import { UpdateLead } from '@application/use-cases/UpdateLead';
import { DeleteLead } from '@application/use-cases/DeleteLead';
import { ConvertLeadToClient } from '@application/use-cases/ConvertLeadToClient';
import { Lead } from '@domain/entities/lead';

export function createLeadsRouter(
  listLeads: ListLeads,
  getLead: GetLead,
  createLead: CreateLead,
  updateLead: UpdateLead,
  deleteLead: DeleteLead,
  convertLeadToClient: ConvertLeadToClient,
): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response): Promise<void> => {
    const leads = await listLeads.execute();
    res.json(leads);
  });

  router.get('/:id', async (req: Request, res: Response): Promise<void> => {
    const lead = await getLead.execute(req.params['id'] as string);
    if (!lead) {
      res.status(404).json({ error: 'Lead not found', code: 'LEAD_NOT_FOUND' });
      return;
    }
    res.json(lead);
  });

  router.post('/', async (req: Request, res: Response): Promise<void> => {
    const data = req.body as Omit<Lead, 'id' | 'createdAt' | 'convertedAt' | 'convertedClientId'>;
    const lead = await createLead.execute(data);
    res.status(201).json(lead);
  });

  router.put('/:id', async (req: Request, res: Response): Promise<void> => {
    const lead = await updateLead.execute(req.params['id'] as string, req.body as Partial<Lead>);
    if (!lead) {
      res.status(404).json({ error: 'Lead not found', code: 'LEAD_NOT_FOUND' });
      return;
    }
    res.json(lead);
  });

  router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
    const deleted = await deleteLead.execute(req.params['id'] as string);
    if (!deleted) {
      res.status(404).json({ error: 'Lead not found', code: 'LEAD_NOT_FOUND' });
      return;
    }
    res.status(204).send();
  });

  router.post('/:id/convert', async (req: Request, res: Response): Promise<void> => {
    const { clientId } = req.body as { clientId: string };
    const lead = await convertLeadToClient.execute(req.params['id'] as string, clientId);
    if (!lead) {
      res.status(404).json({ error: 'Lead not found', code: 'LEAD_NOT_FOUND' });
      return;
    }
    res.json(lead);
  });

  return router;
}
