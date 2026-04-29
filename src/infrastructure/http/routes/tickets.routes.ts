import { Router, Request, Response } from 'express';
import { ListTickets } from '@application/use-cases/ListTickets';
import { GetTicketStats } from '@application/use-cases/GetTicketStats';
import { CreateTicket } from '@application/use-cases/CreateTicket';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { JwtAuthAdapter } from '../../adapters/jwt/JwtAuthAdapter';
import { incrementTickets, decrementTickets } from '../../adapters/in-memory/shared-stores';

export interface TicketReply {
  id: number;
  ticketId: number;
  message: string;
  authorId: number;
  authorName: string;
  createdAt: string;
  isInternal: boolean;
}

// In-memory store for ticket replies (keyed by ticketId)
const ticketRepliesStore = new Map<number, TicketReply[]>([
  [1, [
    { id: 1, ticketId: 1, message: 'Recibimos tu reporte, estamos investigando el problema.', authorId: 1, authorName: 'Soporte Técnico', createdAt: '2024-01-01T10:00:00Z', isInternal: false },
    { id: 2, ticketId: 1, message: 'El equipo de campo ya fue enviado a revisar la infraestructura.', authorId: 2, authorName: 'Admin', createdAt: '2024-01-01T11:30:00Z', isInternal: false },
    { id: 3, ticketId: 1, message: 'NOTA INTERNA: Parece un corte de fibra en la zona norte.', authorId: 2, authorName: 'Admin', createdAt: '2024-01-01T11:35:00Z', isInternal: true },
  ]],
  [2, [
    { id: 4, ticketId: 2, message: 'Por favor verificá tu factura en el portal de clientes.', authorId: 1, authorName: 'Soporte Técnico', createdAt: '2024-01-02T09:00:00Z', isInternal: false },
    { id: 5, ticketId: 2, message: 'Si el error persiste, envianos una captura de pantalla.', authorId: 1, authorName: 'Soporte Técnico', createdAt: '2024-01-02T09:15:00Z', isInternal: false },
  ]],
]);

let nextReplyId = 100;

// In-memory store for ticket status overrides (ticketId -> status)
const ticketStatusStore = new Map<number, string>();

// In-memory store for ticket assignment overrides
interface TicketAssignment {
  assignedTo: number | null;
  assignedToName: string | null;
}
const ticketAssignmentStore = new Map<number, TicketAssignment>();

// In-memory store for ticket field edits
const ticketEditsStore: Record<number, Partial<{ subject: string; message: string; priority: string }>> = {};

// In-memory store for deleted ticket ids
const deletedTicketsStore = new Set<number>();

export function createTicketsRouter(
  listTickets: ListTickets,
  getStats: GetTicketStats,
  createTicket: CreateTicket,
  authProvider: JwtAuthAdapter,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider);

  router.get('/stats', auth, async (_req: Request, res: Response): Promise<void> => {
    const stats = await getStats.execute();
    res.json(stats);
  });

  router.get('/', auth, async (req: Request, res: Response): Promise<void> => {
    const { page, limit, search, status, priority } = req.query as Record<string, string>;
    const result = await listTickets.execute({ page: page ? +page : 1, limit: limit ? +limit : 25, search, status, priority });
    const filtered = { ...result, data: result.data.filter((t) => !deletedTicketsStore.has(Number(t.id))) };
    res.json(filtered);
  });

  router.get('/:id', auth, async (req: Request, res: Response): Promise<void> => {
    const id = req.params['id'] as string;
    if (deletedTicketsStore.has(Number(id))) {
      res.status(404).json({ error: 'Ticket not found', code: 'TICKET_NOT_FOUND' });
      return;
    }
    const result = await listTickets.execute({ page: 1, limit: 1000 });
    const ticket = result.data.find((t) => String(t.id) === id);
    if (!ticket) {
      res.status(404).json({ error: 'Ticket not found', code: 'TICKET_NOT_FOUND' });
      return;
    }
    // Apply any status override and field edits from in-memory store
    const statusOverride = ticketStatusStore.get(Number(id));
    const edits = ticketEditsStore[Number(id)] ?? {};
    res.json({ ...ticket, ...(statusOverride ? { status: statusOverride } : {}), ...edits });
  });

  router.patch('/:id/status', auth, async (req: Request, res: Response): Promise<void> => {
    const id = req.params['id'] as string;
    const { status } = req.body as { status?: string };
    const validStatuses = ['open', 'pending', 'resolved', 'closed'];
    if (!status || !validStatuses.includes(status)) {
      res.status(400).json({ error: 'Invalid or missing status. Must be one of: open, pending, resolved, closed', code: 'VALIDATION_ERROR' });
      return;
    }
    const result = await listTickets.execute({ page: 1, limit: 1000 });
    const ticket = result.data.find((t) => String(t.id) === id);
    if (!ticket) {
      res.status(404).json({ error: 'Ticket not found', code: 'TICKET_NOT_FOUND' });
      return;
    }
    ticketStatusStore.set(Number(id), status);
    res.json({ ...ticket, status });
  });

  router.patch('/:id', auth, async (req: Request, res: Response): Promise<void> => {
    const id = req.params['id'] as string;
    const { subject, message, priority } = req.body as { subject?: string; message?: string; priority?: string };
    if (deletedTicketsStore.has(Number(id))) {
      res.status(404).json({ error: 'Ticket not found', code: 'TICKET_NOT_FOUND' });
      return;
    }
    const result = await listTickets.execute({ page: 1, limit: 1000 });
    const ticket = result.data.find((t) => String(t.id) === id);
    if (!ticket) {
      res.status(404).json({ error: 'Ticket not found', code: 'TICKET_NOT_FOUND' });
      return;
    }
    const existing = ticketEditsStore[Number(id)] ?? {};
    if (subject !== undefined) existing.subject = subject;
    if (message !== undefined) existing.message = message;
    if (priority !== undefined) existing.priority = priority;
    ticketEditsStore[Number(id)] = existing;
    const statusOverride = ticketStatusStore.get(Number(id));
    res.json({ ...ticket, ...(statusOverride ? { status: statusOverride } : {}), ...existing });
  });

  router.delete('/:id', auth, async (req: Request, res: Response): Promise<void> => {
    const id = req.params['id'] as string;
    if (deletedTicketsStore.has(Number(id))) {
      res.status(404).json({ error: 'Ticket not found', code: 'TICKET_NOT_FOUND' });
      return;
    }
    const result = await listTickets.execute({ page: 1, limit: 1000 });
    const ticket = result.data.find((t) => String(t.id) === id);
    if (!ticket) {
      res.status(404).json({ error: 'Ticket not found', code: 'TICKET_NOT_FOUND' });
      return;
    }
    deletedTicketsStore.add(Number(id));
    decrementTickets('open');
    res.status(204).send();
  });

  router.get('/:id/replies', auth, async (req: Request, res: Response): Promise<void> => {
    const id = Number(req.params['id']);
    const replies = ticketRepliesStore.get(id) ?? [];
    res.json(replies);
  });

  router.post('/:id/replies', auth, async (req: Request, res: Response): Promise<void> => {
    const ticketId = Number(req.params['id']);
    const { message, authorId, authorName } = req.body as { message?: string; authorId?: number; authorName?: string };
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

  router.patch('/:id/assign', auth, async (req: Request, res: Response): Promise<void> => {
    const id = req.params['id'] as string;
    const { assignedTo, assignedToName } = req.body as { assignedTo?: number | null; assignedToName?: string | null };
    const result = await listTickets.execute({ page: 1, limit: 1000 });
    const ticket = result.data.find((t) => String(t.id) === id);
    if (!ticket) {
      res.status(404).json({ error: 'Ticket not found', code: 'TICKET_NOT_FOUND' });
      return;
    }
    const assignment: TicketAssignment = {
      assignedTo: assignedTo ?? null,
      assignedToName: assignedToName ?? null,
    };
    ticketAssignmentStore.set(Number(id), assignment);
    const statusOverride = ticketStatusStore.get(Number(id));
    res.json({ ...ticket, ...(statusOverride ? { status: statusOverride } : {}), ...assignment });
  });

  router.post('/', auth, async (req: Request, res: Response): Promise<void> => {
    const { subject, clientId, priority, description, assignedTo } = req.body as {
      subject?: string; clientId?: string; priority?: 'alta' | 'media' | 'baja'; description?: string; assignedTo?: string;
    };
    if (!subject || !clientId || !priority || !description) {
      res.status(400).json({ error: 'Missing required fields: subject, clientId, priority, description', code: 'VALIDATION_ERROR' });
      return;
    }
    const ticket = await createTicket.execute({ subject, clientId, priority, description, assignedTo });
    incrementTickets('open');
    res.status(201).json(ticket);
  });

  return router;
}
