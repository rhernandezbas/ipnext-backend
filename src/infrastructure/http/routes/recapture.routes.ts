import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { ListRecaptureLeads } from '@application/use-cases/recapture/ListRecaptureLeads';
import { GetRecaptureLead } from '@application/use-cases/recapture/GetRecaptureLead';
import { UpdateRecaptureLeadStatus } from '@application/use-cases/recapture/UpdateRecaptureLeadStatus';
import { AddRecaptureContact } from '@application/use-cases/recapture/AddRecaptureContact';
import { IngestChurnedClients } from '@application/use-cases/recapture/IngestChurnedClients';
import { ImportCsvLeads } from '@application/use-cases/recapture/ImportCsvLeads';
import { AssignRecaptureLead } from '@application/use-cases/recapture/AssignRecaptureLead';
import { AssignRecaptureLeadsBulk } from '@application/use-cases/recapture/AssignRecaptureLeadsBulk';
import { RecaptureLeadNotFoundError } from '@domain/errors/recapture';
import { ReferenceNotFoundError } from '@domain/errors/scheduling';
import type { RecaptureLeadStatus, RecaptureLeadSource, RecaptureContactChannel, RecaptureContactOutcome } from '@domain/entities/recaptureLead';

/** Per-route permission guards (recapture read/manage/assign). */
export interface RecaptureRoutePerms {
  read: RequestHandler;
  manage: RequestHandler;
  assign: RequestHandler;
}

const VALID_STATUSES: RecaptureLeadStatus[] = [
  'nuevo', 'en_gestion', 'contactado', 'interesado', 'recuperado', 'descartado',
];

const VALID_SOURCES: RecaptureLeadSource[] = ['churned_client', 'csv'];

const VALID_CHANNELS: RecaptureContactChannel[] = ['llamada', 'whatsapp', 'email', 'sms', 'otro'];

const VALID_OUTCOMES: RecaptureContactOutcome[] = [
  'sin_respuesta', 'contactado', 'no_interesado', 'interesado', 'recuperado', 'numero_erroneo',
];

export function createRecaptureRouter(
  listLeads: ListRecaptureLeads,
  getLead: GetRecaptureLead,
  updateStatus: UpdateRecaptureLeadStatus,
  addContact: AddRecaptureContact,
  ingestChurned: IngestChurnedClients,
  importCsv: ImportCsvLeads,
  assignLead: AssignRecaptureLead,
  assignBulk: AssignRecaptureLeadsBulk,
  hasAssignPerm: (userId: string) => Promise<boolean>,
  auth: RequestHandler,
  perms: RecaptureRoutePerms,
): Router {
  const router = Router();

  // â”€â”€â”€ POST /ingest-churned (assign) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Mounted BEFORE /leads to avoid /:id capture
  router.post(
    '/ingest-churned',
    auth,
    perms.assign,
    async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const result = await ingestChurned.execute();
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // â”€â”€â”€ GET /import-csv/template (read) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Mounted BEFORE /leads to avoid route shadowing
  router.get(
    '/import-csv/template',
    auth,
    perms.read,
    (_req: Request, res: Response): void => {
      const headers = 'nombre,telefono,email,direccion,motivo_baja,plan_anterior';
      const example = 'Juan PÃ©rez,1154321234,juan@correo.com,Av. Corrientes 1234,precio,plan_basico';
      const body = `${headers}\n${example}\n`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="recaptacion-template.csv"');
      res.status(200).send(body);
    },
  );

  // â”€â”€â”€ POST /import-csv (assign) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  router.post(
    '/import-csv',
    auth,
    perms.assign,
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

  // â”€â”€â”€ PATCH /leads/assign-bulk (assign) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Mounted BEFORE /leads/:id to avoid /:id capture
  router.patch(
    '/leads/assign-bulk',
    auth,
    perms.assign,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const { leadIds, operatorId } = req.body as { leadIds?: unknown; operatorId?: unknown };

      // leadIds must be a non-empty array of strings
      if (
        !Array.isArray(leadIds) ||
        leadIds.length === 0 ||
        !leadIds.every((id) => typeof id === 'string')
      ) {
        res.status(400).json({
          error: 'leadIds must be a non-empty array of strings',
          code: 'VALIDATION_ERROR',
        });
        return;
      }

      // operatorId must be explicitly present (null is valid â€” means unassign)
      if (!('operatorId' in req.body)) {
        res.status(400).json({ error: 'Missing required field: operatorId', code: 'VALIDATION_ERROR' });
        return;
      }

      if (operatorId !== null && typeof operatorId !== 'string') {
        res.status(400).json({ error: 'operatorId must be a string or null', code: 'VALIDATION_ERROR' });
        return;
      }

      try {
        const result = await assignBulk.execute(leadIds as string[], operatorId as string | null);
        res.json(result);
      } catch (err) {
        if (err instanceof ReferenceNotFoundError) {
          res.status(400).json({ error: err.message, code: 'REFERENCE_NOT_FOUND' });
          return;
        }
        next(err);
      }
    },
  );

  // â”€â”€â”€ GET /leads (read) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  router.get(
    '/leads',
    auth,
    perms.read,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const actorId = (req as any).user?.id as string;
        const isAdmin = await hasAssignPerm(actorId);

        // Fail-closed (defense in depth): a non-admin without a resolvable actorId
        // would otherwise get an unscoped assignee filter and see EVERY lead.
        if (!isAdmin && !actorId) {
          res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
          return;
        }

        const { status, assigneeId, unassigned, page, limit, source } = req.query as Record<string, string>;

        // Non-admin agents can only see their own leads
        const effectiveAssigneeId = isAdmin ? (assigneeId || undefined) : actorId;
        const effectiveUnassigned = isAdmin ? unassigned === 'true' : false;

        const result = await listLeads.execute({
          source: VALID_SOURCES.includes(source as RecaptureLeadSource) ? (source as RecaptureLeadSource) : undefined,
          status: VALID_STATUSES.includes(status as RecaptureLeadStatus) ? (status as RecaptureLeadStatus) : undefined,
          assigneeId: effectiveAssigneeId,
          unassigned: effectiveUnassigned,
          page: page ? +page : 1,
          limit: limit ? +limit : 25,
        });
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // â”€â”€â”€ GET /leads/:id (read) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  router.get(
    '/leads/:id',
    auth,
    perms.read,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const actorId = (req as any).user?.id as string;
        const isAdmin = await hasAssignPerm(actorId);
        const lead = await getLead.execute(req.params['id'] as string);

        // Non-admin agents can only see their own leads
        if (!isAdmin && lead.assigneeId !== actorId) {
          res.status(404).json({ error: 'Recapture lead not found', code: 'RECAPTURE_LEAD_NOT_FOUND' });
          return;
        }

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

  // â”€â”€â”€ PATCH /leads/:id (manage) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  router.patch(
    '/leads/:id',
    auth,
    perms.manage,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const actorId = (req as any).user?.id as string;
      const isAdmin = await hasAssignPerm(actorId);

      // Non-admin agents can only mutate their own leads â€” check ownership first
      if (!isAdmin) {
        try {
          const existing = await getLead.execute(req.params['id'] as string);
          if (existing.assigneeId !== actorId) {
            res.status(404).json({ error: 'Recapture lead not found', code: 'RECAPTURE_LEAD_NOT_FOUND' });
            return;
          }
        } catch (err) {
          if (err instanceof RecaptureLeadNotFoundError) {
            res.status(404).json({ error: err.message, code: err.code });
            return;
          }
          next(err);
          return;
        }
      }

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

  // â”€â”€â”€ POST /leads/:id/contacts (manage) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  router.post(
    '/leads/:id/contacts',
    auth,
    perms.manage,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const actorId = (req as any).user?.id as string;
      const isAdmin = await hasAssignPerm(actorId);

      // Non-admin agents can only mutate their own leads â€” check ownership first
      if (!isAdmin) {
        try {
          const existing = await getLead.execute(req.params['id'] as string);
          if (existing.assigneeId !== actorId) {
            res.status(404).json({ error: 'Recapture lead not found', code: 'RECAPTURE_LEAD_NOT_FOUND' });
            return;
          }
        } catch (err) {
          if (err instanceof RecaptureLeadNotFoundError) {
            res.status(404).json({ error: err.message, code: err.code });
            return;
          }
          next(err);
          return;
        }
      }

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

  // â”€â”€â”€ PATCH /leads/:id/assign (assign) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  router.patch(
    '/leads/:id/assign',
    auth,
    perms.assign,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      // operatorId must be present in the body (null is valid â€” means unassign)
      if (!('operatorId' in req.body)) {
        res.status(400).json({ error: 'Missing required field: operatorId', code: 'VALIDATION_ERROR' });
        return;
      }

      const { operatorId } = req.body as { operatorId: string | null };

      if (operatorId !== null && typeof operatorId !== 'string') {
        res.status(400).json({ error: 'operatorId must be a string or null', code: 'VALIDATION_ERROR' });
        return;
      }

      try {
        const lead = await assignLead.execute(req.params['id'] as string, operatorId);
        res.json(lead);
      } catch (err) {
        if (err instanceof RecaptureLeadNotFoundError) {
          res.status(404).json({ error: err.message, code: err.code });
          return;
        }
        if (err instanceof ReferenceNotFoundError) {
          res.status(400).json({ error: err.message, code: 'REFERENCE_NOT_FOUND' });
          return;
        }
        next(err);
      }
    },
  );

  return router;
}

