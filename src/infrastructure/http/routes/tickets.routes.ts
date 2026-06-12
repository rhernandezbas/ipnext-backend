import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { ListTickets } from '@application/use-cases/ListTickets';
import { GetTicketStats } from '@application/use-cases/GetTicketStats';
import { CreateTicket } from '@application/use-cases/CreateTicket';
import { GetTicket } from '@application/use-cases/GetTicket';
import { UpdateTicketStatus } from '@application/use-cases/UpdateTicketStatus';
import { UpdateTicket } from '@application/use-cases/UpdateTicket';
import { CloseTicket } from '@application/use-cases/CloseTicket';
import { CreateTaskFromTicket } from '@application/use-cases/CreateTaskFromTicket';
import { TicketPriority } from '@domain/entities/ticket';
import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { StageRepository } from '@domain/ports/StageRepository';
import { TicketStatusRepository } from '@domain/ports/TicketStatusRepository';
import { TicketAreaCatalogRepository } from '@domain/ports/TicketAreaCatalogRepository';
import { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import { ReferenceNotFoundError } from '@domain/errors/scheduling';
import { NoClosableStatusError, TicketAreaRequiredError, TicketAreaNotFoundError } from '@domain/errors/tickets';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { JwtAuthAdapter } from '../../adapters/jwt/JwtAuthAdapter';

// Zod schema for POST /api/tickets/:id/tasks body
// contractId is REQUIRED (AD-2: ticket has no contractId — FE picks from client contracts)
const CreateTaskFromTicketSchema = z.object({
  contractId:     z.string().min(1),
  customerId:     z.string().min(1).optional(),
  title:          z.string().min(1).optional(),
  description:    z.string().nullable().optional(),
  priority:       z.string().min(1).optional(),
  estimatedHours: z.number().nonnegative().optional(),
  category:       z.string().min(1).optional(),
  stageId:        z.string().min(1).optional(),
  assigneeId:     z.string().min(1).nullable().optional(),
  reporterId:     z.string().min(1).nullable().optional(),
  partnerId:      z.string().min(1).nullable().optional(),
  projectId:      z.string().min(1).nullable().optional(),
  projectName:    z.string().nullable().optional(),
  address:        z.string().nullable().optional(),
  coordinates:    z.object({ lat: z.number(), lng: z.number() }).nullable().optional(),
  notes:          z.string().nullable().optional(),
  completedAt:    z.string().nullable().optional(),
  startDate:      z.string().datetime({ offset: true }).nullable().optional(),
  endDate:        z.string().datetime({ offset: true }).nullable().optional(),
  travelTimeTo:   z.number().int().nonnegative().nullable().optional(),
  travelTimeFrom: z.number().int().nonnegative().nullable().optional(),
});

// Error code mapping for ReferenceNotFoundError kinds (mirrors scheduling.routes.ts)
const REFERENCE_TO_CODE: Record<string, string> = {
  customer: 'CUSTOMER_NOT_FOUND',
  contract: 'CONTRACT_NOT_FOUND',
  partner:  'PARTNER_NOT_FOUND',
  project:  'PROJECT_NOT_FOUND',
  reporter: 'REPORTER_NOT_FOUND',
  assignee: 'ASSIGNEE_NOT_FOUND',
  watcher:  'WATCHER_NOT_FOUND',
  ticket:   'TICKET_NOT_FOUND',
};

// Ticket status is validated against the editable TicketStatusCatalog (the single
// source of truth), not a hardcoded whitelist. See PATCH /:id/status and GET /.
const VALID_PRIORITIES: TicketPriority[] = ['low', 'medium', 'high'];

// #44 — replies were in-memory and lost on each deploy. Replaced by persisted
// ticket comments (createTicketCommentsRouter mounted on /api/tickets in app.ts).

export function createTicketsRouter(
  listTickets: ListTickets,
  getStats: GetTicketStats,
  createTicket: CreateTicket,
  getTicket: GetTicket,
  updateStatus: UpdateTicketStatus,
  updateTicket: UpdateTicket,
  closeTicket: CloseTicket,
  ticketStatusRepo: TicketStatusRepository,
  authProvider: JwtAuthAdapter,
  // #48 — used to validate a body-provided reporterId exists before persisting.
  // Optional so legacy wirings/tests that never set an explicit reporter still work.
  rbacUserRepo?: RbacUserRepository,
  createTaskFromTicket?: CreateTaskFromTicket,
  taskRepo?: SchedulingRepository,
  stageRepo?: StageRepository,
  // #49 — used to validate areaId on create (required) and update (optional).
  // Optional so legacy tests/wirings compiled before BATCH 2 still compile.
  areaRepo?: TicketAreaCatalogRepository,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider);

  // GET /stats — must come before /:id to avoid capture
  router.get('/stats', auth, async (_req: Request, res: Response): Promise<void> => {
    try {
      const stats = await getStats.execute();
      res.json(stats);
    } catch (err) {
      console.error('[tickets] getStats error', err);
      res.status(500).json({ error: 'Error interno', code: 'INTERNAL_ERROR' });
    }
  });

  // GET / — list tickets, optional ?customerId filter
  router.get('/', auth, async (req: Request, res: Response): Promise<void> => {
    try {
      const { page, limit, search, status, priority, customerId, assignedTo, from, to, areaId } = req.query as Record<string, string>;
      const result = await listTickets.execute({
        page: page ? +page : 1,
        limit: limit ? +limit : 25,
        search,
        status: status || undefined, // AD-5: pass-through; el catálogo es la fuente de verdad, sin whitelist
        priority: VALID_PRIORITIES.includes(priority as TicketPriority) ? (priority as TicketPriority) : undefined,
        customerId,
        assigneeId: assignedTo || undefined, // #25 — FE manda `assignedTo`; el repo filtra por assigneeId
        from: from || undefined,
        to: to || undefined,
        areaId: areaId || undefined,          // #49 — filtrar por área
      });
      res.json(result);
    } catch (err) {
      console.error('[tickets] list error', err);
      res.status(500).json({ error: 'Error interno', code: 'INTERNAL_ERROR' });
    }
  });

  // GET /:id — get a single ticket by id
  router.get('/:id', auth, async (req: Request, res: Response): Promise<void> => {
    try {
      const id = req.params['id'] as string;
      const ticket = await getTicket.execute(id);
      if (!ticket) {
        res.status(404).json({ error: 'Ticket not found', code: 'TICKET_NOT_FOUND' });
        return;
      }
      res.json(ticket);
    } catch (err) {
      console.error('[tickets] getById error', err);
      res.status(500).json({ error: 'Error interno', code: 'INTERNAL_ERROR' });
    }
  });

  // PATCH /:id/status — change status
  router.patch('/:id/status', auth, async (req: Request, res: Response): Promise<void> => {
    const id = req.params['id'] as string;
    const { status } = req.body as { status?: string };

    if (!status) {
      res.status(400).json({
        error: 'Missing required field: status',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    try {
      // Validate against the editable catalog (case-insensitive), not a whitelist.
      const catalogEntry = await ticketStatusRepo.getByName(status);
      if (!catalogEntry) {
        res.status(422).json({
          error: `Status "${status}" is not in the ticket status catalog`,
          code: 'TICKET_STATUS_NOT_FOUND',
        });
        return;
      }

      // AD-3: persist the canonical catalog name (avoids casing drift, e.g. 'cerrado' → 'Cerrado').
      const ticket = await updateStatus.execute(id, catalogEntry.name);
      if (!ticket) {
        res.status(404).json({ error: 'Ticket not found', code: 'TICKET_NOT_FOUND' });
        return;
      }
      res.json(ticket);
    } catch (err) {
      console.error('[tickets] updateStatus error', err);
      res.status(500).json({ error: 'Error interno', code: 'INTERNAL_ERROR' });
    }
  });

  // PATCH /:id — update ticket fields in a single unified save (#48).
  // Accepts subject, description, priority, assigneeId AND status. The status is
  // validated against the editable TicketStatusCatalog (case-insensitive, never a
  // whitelist — lección #46) and persisted as its CANONICAL name. Validation runs
  // BEFORE any persistence so an invalid status never partially applies the other
  // fields (REQ-TICKET-UPDATE-2).
  router.patch('/:id', auth, async (req: Request, res: Response): Promise<void> => {
    const id = req.params['id'] as string;
    const { subject, description, priority, assigneeId, status, areaId } = req.body as {
      subject?: string;
      description?: string;
      priority?: string;
      assigneeId?: string | null;
      status?: string;
      areaId?: string | null;
    };

    try {
      // #48 — validate status against the catalog up-front (422 if unknown), and
      // resolve the canonical name. Mirrors PATCH /:id/status.
      let canonicalStatus: string | undefined;
      if (status !== undefined) {
        const catalogEntry = await ticketStatusRepo.getByName(status);
        if (!catalogEntry) {
          res.status(422).json({
            error: `Status "${status}" is not in the ticket status catalog`,
            code: 'TICKET_STATUS_NOT_FOUND',
          });
          return;
        }
        canonicalStatus = catalogEntry.name;
      }

      // #49 — validate areaId when present. null = clear (valid); non-null = must exist.
      if (areaId !== undefined && areaId !== null && areaRepo) {
        const areaEntry = await areaRepo.getById(areaId);
        if (!areaEntry) {
          res.status(422).json({
            error: `Area "${areaId}" not found`,
            code: 'TICKET_AREA_NOT_FOUND',
          });
          return;
        }
      }

      const ticket = await updateTicket.execute(id, {
        ...(subject !== undefined && { subject }),
        ...(description !== undefined && { description }),
        ...(priority !== undefined &&
          VALID_PRIORITIES.includes(priority as TicketPriority) && { priority: priority as TicketPriority }),
        ...(assigneeId !== undefined && { assigneeId: assigneeId ?? null }),
        ...(canonicalStatus !== undefined && { status: canonicalStatus }),
        ...(areaId !== undefined && { areaId: areaId ?? null }),           // #49
      });
      if (!ticket) {
        res.status(404).json({ error: 'Ticket not found', code: 'TICKET_NOT_FOUND' });
        return;
      }
      res.json(ticket);
    } catch (err) {
      console.error('[tickets] update error', err);
      res.status(500).json({ error: 'Error interno', code: 'INTERNAL_ERROR' });
    }
  });

  // DELETE /:id — closes the ticket (soft delete via the catalog's closed status,
  // preserves history). The closed status NAME is resolved from the catalog
  // (case-insensitive, fallback 'cerrado') by CloseTicket — never hardcoded.
  router.delete('/:id', auth, async (req: Request, res: Response): Promise<void> => {
    try {
      const id = req.params['id'] as string;
      const ticket = await closeTicket.execute(id);
      if (!ticket) {
        res.status(404).json({ error: 'Ticket not found', code: 'TICKET_NOT_FOUND' });
        return;
      }
      res.json(ticket);
    } catch (err) {
      // M1 (#46): no closed-like status in the catalog is a 422, not a 500.
      if (err instanceof NoClosableStatusError) {
        res.status(422).json({ error: err.message, code: err.code });
        return;
      }
      console.error('[tickets] close error', err);
      res.status(500).json({ error: 'Error interno', code: 'INTERNAL_ERROR' });
    }
  });

  // POST /:id/tasks — create a task from a ticket (AD-7: mounted BEFORE /:id to avoid capture)
  // contractId is REQUIRED in the body (AD-2: ticket has no contractId).
  // ticketId comes from the path — NOT body-overridable.
  router.post('/:id/tasks', auth, async (req: Request, res: Response): Promise<void> => {
    if (!createTaskFromTicket) {
      res.status(501).json({ error: 'Not implemented', code: 'NOT_IMPLEMENTED' });
      return;
    }

    const ticketId = req.params['id'] as string;
    const parsed = CreateTaskFromTicketSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }

    const data = parsed.data;

    // Resolve default stageId (AD-8: mirrors scheduling.routes.ts pattern)
    let stageId = data.stageId;
    if (!stageId) {
      if (stageRepo) {
        const defaultStage = await stageRepo.getDefaultWorkflowStageByLegacyStatus('pending');
        if (!defaultStage) {
          res.status(500).json({ error: 'Default workflow not seeded', code: 'INTERNAL_ERROR' });
          return;
        }
        stageId = defaultStage.id;
      } else {
        stageId = '10000000-0000-4000-a000-000000000001';
      }
    }

    try {
      const task = await createTaskFromTicket.execute({
        ticketId,                                            // from path — NOT body
        ticketSubject: data.title ?? `Ticket #${ticketId}`, // prefill from title or fallback
        title: data.title ?? `Ticket #${ticketId}`,
        description: data.description ?? null,
        stageId,
        priority: data.priority ?? 'normal',
        estimatedHours: data.estimatedHours ?? 1,
        category: data.category ?? 'support',
        contractId: data.contractId,
        customerId: data.customerId ?? null,
        assigneeId: data.assigneeId ?? null,
        reporterId: data.reporterId ?? req.user?.id ?? null,
        partnerId: data.partnerId ?? null,
        projectId: data.projectId ?? null,
        projectName: data.projectName ?? null,
        address: data.address ?? null,
        coordinates: data.coordinates ?? null,
        notes: data.notes ?? null,
        completedAt: data.completedAt ?? null,
        startDate: data.startDate ?? null,
        endDate: data.endDate ?? null,
        travelTimeTo: data.travelTimeTo ?? null,
        travelTimeFrom: data.travelTimeFrom ?? null,
      });
      res.status(201).json(task);
    } catch (err) {
      if (err instanceof ReferenceNotFoundError) {
        const code = REFERENCE_TO_CODE[err.kind] ?? 'REFERENCE_NOT_FOUND';
        const status = err.kind === 'ticket' ? 404 : 422;
        res.status(status).json({ error: err.message, code });
        return;
      }
      console.error('[tickets] createTaskFromTicket error', err);
      res.status(500).json({ error: 'Error interno', code: 'INTERNAL_ERROR' });
    }
  });

  // POST / — create ticket
  router.post('/', auth, async (req: Request, res: Response): Promise<void> => {
    const { subject, description, customerId, priority, assigneeId, reporterId, areaId } = req.body as {
      subject?: string;
      description?: string;
      customerId?: string | null;
      priority?: string;
      assigneeId?: string | null;
      reporterId?: string | null;
      areaId?: string;
    };

    if (!subject || !description) {
      res.status(400).json({
        error: 'Missing required fields: subject, description',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    try {
      // #48 — a body-provided reporterId must reference a real user. Without this
      // guard an unknown id reaches Prisma as an FK violation (P2003 → 500) and
      // also lets a caller spoof an arbitrary reporter. Validate up-front → 422.
      // The session-default stamp (req.user.id) is NOT re-validated: the session
      // user exists by definition.
      if (reporterId != null && rbacUserRepo) {
        const reporterUser = await rbacUserRepo.findById(reporterId);
        if (!reporterUser) {
          res.status(422).json({
            error: `Reporter "${reporterId}" is not a known user`,
            code: 'REPORTER_NOT_FOUND',
          });
          return;
        }
      }

      // #49 — areaId is required when an area catalog is wired. Mirrors how
      // reporterId validation only runs when rbacUserRepo is provided.
      if (areaRepo) {
        if (!areaId) {
          res.status(422).json({
            error: 'Ticket area is required',
            code: 'TICKET_AREA_REQUIRED',
          });
          return;
        }
        const areaEntry = await areaRepo.getById(areaId);
        if (!areaEntry) {
          res.status(422).json({
            error: `Area "${areaId}" not found`,
            code: 'TICKET_AREA_NOT_FOUND',
          });
          return;
        }
      }

      const ticket = await createTicket.execute({
        subject,
        description,
        customerId: customerId ?? null,
        priority: VALID_PRIORITIES.includes(priority as TicketPriority)
          ? (priority as TicketPriority)
          : 'medium',
        assigneeId: assigneeId ?? null,
        // #48 — stamp the creator from the session when the body omits it.
        // Mirror of POST /:id/tasks. Explicit body value wins.
        reporterId: reporterId ?? req.user?.id ?? null,
        areaId,  // #49 — already validated above
      });
      res.status(201).json(ticket);
    } catch (err) {
      console.error('[tickets] create error', err);
      res.status(500).json({ error: 'Error interno', code: 'INTERNAL_ERROR' });
    }
  });

  return router;
}
