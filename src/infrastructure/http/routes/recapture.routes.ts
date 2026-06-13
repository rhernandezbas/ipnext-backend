import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { ListRecaptureLeads } from '@application/use-cases/recapture/ListRecaptureLeads';
import { GetRecaptureLead } from '@application/use-cases/recapture/GetRecaptureLead';
import { ClaimRecaptureLead } from '@application/use-cases/recapture/ClaimRecaptureLead';
import { ClaimNextRecaptureLead } from '@application/use-cases/recapture/ClaimNextRecaptureLead';
import { ReleaseRecaptureLead } from '@application/use-cases/recapture/ReleaseRecaptureLead';
import { UpdateRecaptureLeadStatus } from '@application/use-cases/recapture/UpdateRecaptureLeadStatus';
import { AddRecaptureContact } from '@application/use-cases/recapture/AddRecaptureContact';
import { IngestChurnedClients } from '@application/use-cases/recapture/IngestChurnedClients';
import { ImportCsvLeads } from '@application/use-cases/recapture/ImportCsvLeads';
import { RecaptureLeadNotFoundError, RecaptureLeadAlreadyClaimedError } from '@domain/errors/recapture';
import type { RecaptureLeadStatus, RecaptureContactChannel, RecaptureContactOutcome } from '@domain/entities/recaptureLead';

/** Per-route permission guards (recapture read/manage). */
export interface RecaptureRoutePerms {
  read: RequestHandler;
  manage: RequestHandler;
}

const VALID_STATUSES: RecaptureLeadStatus[] = [
  'nuevo', 'en_gestion', 'contactado', 'interesado', 'recuperado', 'descartado',
];

const VALID_CHANNELS: RecaptureContactChannel[] = ['llamada', 'whatsapp', 'email', 'sms', 'otro'];

const VALID_OUTCOMES: RecaptureContactOutcome[] = [
  'sin_respuesta', 'contactado', 'no_interesado', 'interesado', 'recuperado', 'numero_erroneo',
];

export function createRecaptureRouter(
  listLeads: ListRecaptureLeads,
  getLead: GetRecaptureLead,
  claimLead: ClaimRecaptureLead,
  claimNextLead: ClaimNextRecaptureLead,
  releaseLead: ReleaseRecaptureLead,
  updateStatus: UpdateRecaptureLeadStatus,
  addContact: AddRecaptureContact,
  ingestChurned: IngestChurnedClients,
  importCsv: ImportCsvLeads,
  auth: RequestHandler,
  perms: RecaptureRoutePerms,
): Router {
  const router = Router();

  // ─── POST /ingest-churned (manage) ─────────────────────────────────────────
  // Mounted BEFORE /leads to avoid /:id capture
  router.post(
    '/ingest-churned',
    auth,
    perms.manage,
    async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const result = await ingestChurned.execute();
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── GET /import-csv/template (read) ──────────────────────────────────────
  // Mounted BEFORE /leads to avoid route shadowing
  router.get(
    '/import-csv/template',
    auth,
    perms.read,
    (_req: Request, res: Response): void => {
      const headers = 'nombre,telefono,email,direccion,motivo_baja,plan_anterior';
      const example = 'Juan Pérez,1154321234,juan@correo.com,Av. Corrientes 1234,precio,plan_basico';
      const body = `${headers}\n${example}\n`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="recaptacion-template.csv"');
      res.status(200).send(body);
    },
  );

  // ─── POST /import-csv (manage) ─────────────────────────────────────────────
  router.post(
    '/import-csv',
    auth,
    perms.manage,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const { csv } = req.body as { csv?: string };
      if (!csv || typeof csv !== 'string') {
        res.status(400).json({ error: 'Missing required field: csv', code: 'VALIDATION_ERROR' });
        return;
      }
      try {
        const result = await importCsv.execute(csv);
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── POST /leads/claim-next (manage) ───────────────────────────────────────
  // Mounted BEFORE /leads/:id to avoid /:id capture
  router.post(
    '/leads/claim-next',
    auth,
    perms.manage,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const actorId = (req as any).user?.id as string;
        const lead = await claimNextLead.execute(actorId);
        if (!lead) {
          res.status(204).end();
          return;
        }
        res.json(lead);
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── GET /leads (read) ──────────────────────────────────────────────────────
  router.get(
    '/leads',
    auth,
    perms.read,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { status, assigneeId, unassigned, page, limit } = req.query as Record<string, string>;
        const result = await listLeads.execute({
          status: VALID_STATUSES.includes(status as RecaptureLeadStatus) ? (status as RecaptureLeadStatus) : undefined,
          assigneeId: assigneeId || undefined,
          unassigned: unassigned === 'true',
          page: page ? +page : 1,
          limit: limit ? +limit : 25,
        });
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── GET /leads/:id (read) ──────────────────────────────────────────────────
  router.get(
    '/leads/:id',
    auth,
    perms.read,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const lead = await getLead.execute(req.params['id'] as string);
        res.json(lead);
      } catch (err) {
        if (err instanceof RecaptureLeadNotFoundError) {
          res.status(404).json({ error: err.message, code: err.code });
          return;
        }
        next(err);
      }
    },
  );

  // ─── POST /leads/:id/claim (manage) ────────────────────────────────────────
  router.post(
    '/leads/:id/claim',
    auth,
    perms.manage,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const actorId = (req as any).user?.id as string;
        const lead = await claimLead.execute(req.params['id'] as string, actorId);
        res.json(lead);
      } catch (err) {
        if (err instanceof RecaptureLeadNotFoundError) {
          res.status(404).json({ error: err.message, code: err.code });
          return;
        }
        if (err instanceof RecaptureLeadAlreadyClaimedError) {
          res.status(409).json({ error: err.message, code: err.code });
          return;
        }
        next(err);
      }
    },
  );

  // ─── POST /leads/:id/release (manage) ──────────────────────────────────────
  router.post(
    '/leads/:id/release',
    auth,
    perms.manage,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const lead = await releaseLead.execute(req.params['id'] as string);
        res.json(lead);
      } catch (err) {
        if (err instanceof RecaptureLeadNotFoundError) {
          res.status(404).json({ error: err.message, code: err.code });
          return;
        }
        next(err);
      }
    },
  );

  // ─── PATCH /leads/:id (manage) ─────────────────────────────────────────────
  router.patch(
    '/leads/:id',
    auth,
    perms.manage,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const { status } = req.body as { status?: string };

      if (!status) {
        res.status(400).json({ error: 'Missing required field: status', code: 'VALIDATION_ERROR' });
        return;
      }

      if (!VALID_STATUSES.includes(status as RecaptureLeadStatus)) {
        res.status(422).json({
          error: `Invalid status: "${status}"`,
          code: 'INVALID_RECAPTURE_STATUS',
        });
        return;
      }

      try {
        const lead = await updateStatus.execute(req.params['id'] as string, status as RecaptureLeadStatus);
        res.json(lead);
      } catch (err) {
        if (err instanceof RecaptureLeadNotFoundError) {
          res.status(404).json({ error: err.message, code: err.code });
          return;
        }
        next(err);
      }
    },
  );

  // ─── POST /leads/:id/contacts (manage) ────────────────────────────────────
  router.post(
    '/leads/:id/contacts',
    auth,
    perms.manage,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const { channel, outcome, proposal, note, nextStepAt, advanceStatus } = req.body as {
        channel?: string;
        outcome?: string;
        proposal?: string | null;
        note?: string | null;
        nextStepAt?: string | null;
        advanceStatus?: string;
      };

      if (!channel || !outcome) {
        res.status(400).json({
          error: 'Missing required fields: channel, outcome',
          code: 'VALIDATION_ERROR',
        });
        return;
      }

      if (!VALID_CHANNELS.includes(channel as RecaptureContactChannel)) {
        res.status(422).json({ error: `Invalid channel: "${channel}"`, code: 'INVALID_CHANNEL' });
        return;
      }

      if (!VALID_OUTCOMES.includes(outcome as RecaptureContactOutcome)) {
        res.status(422).json({ error: `Invalid outcome: "${outcome}"`, code: 'INVALID_OUTCOME' });
        return;
      }

      try {
        const actorId = (req as any).user?.id as string;
        const contact = await addContact.execute({
          leadId: req.params['id'] as string,
          actorId,
          channel: channel as RecaptureContactChannel,
          outcome: outcome as RecaptureContactOutcome,
          proposal: proposal ?? null,
          note: note ?? null,
          nextStepAt: nextStepAt ?? null,
          advanceStatus: advanceStatus && VALID_STATUSES.includes(advanceStatus as RecaptureLeadStatus)
            ? (advanceStatus as RecaptureLeadStatus)
            : undefined,
        });
        res.status(201).json(contact);
      } catch (err) {
        if (err instanceof RecaptureLeadNotFoundError) {
          res.status(404).json({ error: err.message, code: err.code });
          return;
        }
        next(err);
      }
    },
  );

  return router;
}
