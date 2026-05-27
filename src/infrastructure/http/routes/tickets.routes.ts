import { Router, Request, Response } from 'express';
import { ListTickets } from '@application/use-cases/ListTickets';
import { GetTicketStats } from '@application/use-cases/GetTicketStats';
import { CreateTicket } from '@application/use-cases/CreateTicket';
import { GetTicket } from '@application/use-cases/GetTicket';
import { UpdateTicketStatus } from '@application/use-cases/UpdateTicketStatus';
import { UpdateTicket } from '@application/use-cases/UpdateTicket';
import { CloseTicket } from '@application/use-cases/CloseTicket';
import { TicketPriority } from '@domain/entities/ticket';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { JwtAuthAdapter } from '../../adapters/jwt/JwtAuthAdapter';

// Phase 2: TicketStatus is now a dynamic string from the catalog.
// This whitelist preserves the frontend contract (status filter accepts exactly these three names).
// If the catalog grows, update this list or replace with a catalog lookup.
const VALID_STATUSES: string[] = ['open', 'pending', 'closed'];
const VALID_PRIORITIES: TicketPriority[] = ['low', 'medium', 'high'];

// In-memory store for ticket replies (out-of-scope for Prisma this iteration — AD-6)
// TicketReply stays in-memory until the TicketReply model is implemented in a future change.
export interface TicketReply {
  id: number;
  ticketId: string;
  message: string;
  authorId: number;
  authorName: string;
  createdAt: string;
  isInternal: boolean;
}

const ticketRepliesStore = new Map<string, TicketReply[]>();
let nextReplyId = 1;

export function createTicketsRouter(
  listTickets: ListTickets,
  getStats: GetTicketStats,
  createTicket: CreateTicket,
  getTicket: GetTicket,
  updateStatus: UpdateTicketStatus,
  updateTicket: UpdateTicket,
  closeTicket: CloseTicket,
  authProvider: JwtAuthAdapter,
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
      const { page, limit, search, status, priority, customerId } = req.query as Record<string, string>;
      const result = await listTickets.execute({
        page: page ? +page : 1,
        limit: limit ? +limit : 25,
        search,
        status: VALID_STATUSES.includes(status) ? status : undefined,
        priority: VALID_PRIORITIES.includes(priority as TicketPriority) ? (priority as TicketPriority) : undefined,
        customerId,
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

    if (!status || !VALID_STATUSES.includes(status)) {
      res.status(400).json({
        error: `Invalid or missing status. Must be one of: ${VALID_STATUSES.join(', ')}`,
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    try {
      const ticket = await updateStatus.execute(id, status);
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

  // PATCH /:id — update ticket fields (subject, description, priority, assigneeId)
  router.patch('/:id', auth, async (req: Request, res: Response): Promise<void> => {
    const id = req.params['id'] as string;
    const { subject, description, priority, assigneeId } = req.body as {
      subject?: string;
      description?: string;
      priority?: string;
      assigneeId?: string | null;
    };

    try {
      const ticket = await updateTicket.execute(id, {
        ...(subject !== undefined && { subject }),
        ...(description !== undefined && { description }),
        ...(priority !== undefined &&
          VALID_PRIORITIES.includes(priority as TicketPriority) && { priority: priority as TicketPriority }),
        ...(assigneeId !== undefined && { assigneeId: assigneeId ?? null }),
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

  // DELETE /:id — closes the ticket (soft delete via status=closed, preserves history)
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
      console.error('[tickets] close error', err);
      res.status(500).json({ error: 'Error interno', code: 'INTERNAL_ERROR' });
    }
  });

  // GET /:id/replies — in-memory (AD-6: replies out of scope for Prisma this iteration)
  router.get('/:id/replies', auth, async (req: Request, res: Response): Promise<void> => {
    const id = req.params['id'] as string;
    const replies = ticketRepliesStore.get(id) ?? [];
    res.json(replies);
  });

  // POST /:id/replies — in-memory (AD-6)
  router.post('/:id/replies', auth, async (req: Request, res: Response): Promise<void> => {
    const ticketId = req.params['id'] as string;
    const { message, authorId, authorName } = req.body as {
      message?: string;
      authorId?: number;
      authorName?: string;
    };

    if (!message) {
      res.status(400).json({ error: 'message is required', code: 'VALIDATION_ERROR' });
      return;
    }

    const reply: TicketReply = {
      id: nextReplyId++,
      ticketId,
      message,
      authorId: authorId ?? 1,
      authorName: authorName ?? 'Admin',
      createdAt: new Date().toISOString(),
      isInternal: false,
    };

    const existing = ticketRepliesStore.get(ticketId) ?? [];
    existing.push(reply);
    ticketRepliesStore.set(ticketId, existing);
    res.status(201).json(reply);
  });

  // POST / — create ticket
  router.post('/', auth, async (req: Request, res: Response): Promise<void> => {
    const { subject, description, customerId, priority, assigneeId } = req.body as {
      subject?: string;
      description?: string;
      customerId?: string | null;
      priority?: string;
      assigneeId?: string | null;
    };

    if (!subject || !description) {
      res.status(400).json({
        error: 'Missing required fields: subject, description',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    try {
      const ticket = await createTicket.execute({
        subject,
        description,
        customerId: customerId ?? null,
        priority: VALID_PRIORITIES.includes(priority as TicketPriority)
          ? (priority as TicketPriority)
          : 'medium',
        assigneeId: assigneeId ?? null,
      });
      res.status(201).json(ticket);
    } catch (err) {
      console.error('[tickets] create error', err);
      res.status(500).json({ error: 'Error interno', code: 'INTERNAL_ERROR' });
    }
  });

  return router;
}
