import { Router, Request, Response } from 'express';
import { ListCreditNotes } from '@application/use-cases/ListCreditNotes';
import { GetCreditNote } from '@application/use-cases/GetCreditNote';
import { CreateCreditNote } from '@application/use-cases/CreateCreditNote';
import { ApplyCreditNote } from '@application/use-cases/ApplyCreditNote';
import { VoidCreditNote } from '@application/use-cases/VoidCreditNote';

export function createCreditNotesRouter(
  listCreditNotes: ListCreditNotes,
  getCreditNote: GetCreditNote,
  createCreditNote: CreateCreditNote,
  applyCreditNote: ApplyCreditNote,
  voidCreditNote: VoidCreditNote,
): Router {
  const router = Router();

  router.get('/credit-notes', async (_req: Request, res: Response): Promise<void> => {
    const notes = await listCreditNotes.execute();
    res.json(notes);
  });

  router.post('/credit-notes', async (req: Request, res: Response): Promise<void> => {
    const note = await createCreditNote.execute(req.body);
    res.status(201).json(note);
  });

  router.get('/credit-notes/:id', async (req: Request, res: Response): Promise<void> => {
    const note = await getCreditNote.execute(req.params['id'] as string);
    if (!note) {
      res.status(404).json({ error: 'Credit note not found', code: 'CREDIT_NOTE_NOT_FOUND' });
      return;
    }
    res.json(note);
  });

  router.post('/credit-notes/:id/apply', async (req: Request, res: Response): Promise<void> => {
    const note = await applyCreditNote.execute(req.params['id'] as string);
    if (!note) {
      res.status(404).json({ error: 'Credit note not found', code: 'CREDIT_NOTE_NOT_FOUND' });
      return;
    }
    res.json(note);
  });

  router.post('/credit-notes/:id/void', async (req: Request, res: Response): Promise<void> => {
    const note = await voidCreditNote.execute(req.params['id'] as string);
    if (!note) {
      res.status(404).json({ error: 'Credit note not found', code: 'CREDIT_NOTE_NOT_FOUND' });
      return;
    }
    res.json(note);
  });

  return router;
}
