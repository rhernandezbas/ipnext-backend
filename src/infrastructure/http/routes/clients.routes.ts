import { Router, Request, Response } from 'express';
import { ListClients } from '@application/use-cases/ListClients';
import { GetClientDetail } from '@application/use-cases/GetClientDetail';
import { GetClientServices } from '@application/use-cases/GetClientServices';
import { GetClientInvoices } from '@application/use-cases/GetClientInvoices';
import { GetClientLogs } from '@application/use-cases/GetClientLogs';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { JwtAuthAdapter } from '../../adapters/jwt/JwtAuthAdapter';
import { ClientNotFoundError } from '@domain/errors';
import { incrementClients, decrementClients } from '../../adapters/in-memory/shared-stores';

// Module-level online sessions store
interface OnlineSession {
  id: number;
  clientId: number;
  clientName: string;
  ip: string;
  mac: string;
  connectedSince: string;
  downloadMbps: number;
  uploadMbps: number;
}

const onlineSessions: OnlineSession[] = [
  { id: 1, clientId: 1, clientName: 'Alice García', ip: '192.168.1.101', mac: 'AA:BB:CC:DD:EE:01', connectedSince: '2026-04-28T08:00:00Z', downloadMbps: 12.4, uploadMbps: 2.1 },
  { id: 2, clientId: 2, clientName: 'Carlos López', ip: '192.168.1.102', mac: 'AA:BB:CC:DD:EE:02', connectedSince: '2026-04-28T09:30:00Z', downloadMbps: 5.2, uploadMbps: 0.8 },
  { id: 3, clientId: 3, clientName: 'María Rodríguez', ip: '192.168.1.103', mac: 'AA:BB:CC:DD:EE:03', connectedSince: '2026-04-28T07:15:00Z', downloadMbps: 38.7, uploadMbps: 4.3 },
  { id: 4, clientId: 4, clientName: 'Jorge Martínez', ip: '10.0.0.45', mac: 'AA:BB:CC:DD:EE:04', connectedSince: '2026-04-28T10:00:00Z', downloadMbps: 2.1, uploadMbps: 0.3 },
  { id: 5, clientId: 5, clientName: 'Laura Sánchez', ip: '10.0.0.67', mac: 'AA:BB:CC:DD:EE:05', connectedSince: '2026-04-28T06:45:00Z', downloadMbps: 19.5, uploadMbps: 3.2 },
  { id: 6, clientId: 6, clientName: 'Roberto Fernández', ip: '172.16.0.22', mac: 'AA:BB:CC:DD:EE:06', connectedSince: '2026-04-28T11:10:00Z', downloadMbps: 0.4, uploadMbps: 0.1 },
  { id: 7, clientId: 7, clientName: 'Ana González', ip: '172.16.0.89', mac: 'AA:BB:CC:DD:EE:07', connectedSince: '2026-04-28T08:55:00Z', downloadMbps: 7.8, uploadMbps: 1.4 },
  { id: 8, clientId: 8, clientName: 'Pedro Díaz', ip: '192.168.2.11', mac: 'AA:BB:CC:DD:EE:08', connectedSince: '2026-04-28T09:00:00Z', downloadMbps: 24.3, uploadMbps: 5.1 },
];

// In-memory store for client documents
interface ClientDoc {
  id: number;
  name: string;
  size: number;
  uploadedAt: string;
  url: string;
}

// In-memory store for service mutations
interface Service {
  id: number;
  type: string;
  plan: string;
  ipAddress: string | null;
  status: string;
  startDate: string;
  endDate: string | null;
}

const servicesOverrideStore: Record<number, Service[]> = {};
let nextServiceId = 500;

const documentsStore: Record<number, ClientDoc[]> = {
  1: [
    { id: 1, name: 'Contrato.pdf', size: 102400, uploadedAt: '2024-01-15T10:00:00.000Z', url: '/files/contrato.pdf' },
    { id: 2, name: 'DNI.jpg', size: 204800, uploadedAt: '2024-01-16T10:00:00.000Z', url: '/files/dni.jpg' },
  ],
};
let nextDocId = 100;

// In-memory store for deleted client ids
const deletedClientsStore = new Set<number>();

// In-memory store for newly created clients
interface NewClient {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address: string;
  status: 'active' | 'inactive';
  createdAt: string;
}

const newClientsStore: NewClient[] = [];
let nextClientId = 10000;

export function createClientsRouter(
  listClients: ListClients,
  getDetail: GetClientDetail,
  getServices: GetClientServices,
  getInvoices: GetClientInvoices,
  getLogs: GetClientLogs,
  authProvider: JwtAuthAdapter,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider);

  router.get('/', auth, async (req: Request, res: Response): Promise<void> => {
    const { page, limit, search, status } = req.query as Record<string, string>;
    const result = await listClients.execute({ page: page ? +page : 1, limit: limit ? +limit : 25, search, status });
    res.json(result);
  });

  // Online sessions — must be before /:id to avoid param capture
  router.get('/online', auth, (req: Request, res: Response): void => {
    res.json(onlineSessions);
  });

  router.delete('/online/:sessionId', auth, (req: Request, res: Response): void => {
    const idx = onlineSessions.findIndex(s => s.id === parseInt(req.params['sessionId'] as string));
    if (idx === -1) { res.status(404).json({ error: 'Session not found' }); return; }
    onlineSessions.splice(idx, 1);
    res.status(204).send();
  });

  router.get('/:id', auth, async (req: Request, res: Response): Promise<void> => {
    const numId = parseInt(req.params['id'] as string);
    if (deletedClientsStore.has(numId)) {
      res.status(404).json({ error: 'Client not found', code: 'CLIENT_NOT_FOUND' });
      return;
    }
    try {
      const customer = await getDetail.execute(req.params['id'] as string);
      res.json(customer);
    } catch (err) {
      if (err instanceof ClientNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
      } else {
        throw err;
      }
    }
  });

  router.delete('/:id', auth, async (req: Request, res: Response): Promise<void> => {
    const numId = parseInt(req.params['id'] as string);
    if (deletedClientsStore.has(numId)) {
      res.status(404).json({ error: 'Client not found', code: 'CLIENT_NOT_FOUND' });
      return;
    }
    // Only newly created clients can be deleted via this in-memory store
    const inNew = newClientsStore.find((c) => parseInt(c.id) === numId);
    if (!inNew) {
      res.status(404).json({ error: 'Client not found', code: 'CLIENT_NOT_FOUND' });
      return;
    }
    deletedClientsStore.add(numId);
    decrementClients();
    res.status(204).send();
  });

  router.get('/:id/services', auth, async (req: Request, res: Response): Promise<void> => {
    const services = await getServices.execute(req.params['id'] as string);
    res.json(services);
  });

  router.get('/:id/invoices', auth, async (req: Request, res: Response): Promise<void> => {
    const invoices = await getInvoices.execute(req.params['id'] as string);
    res.json(invoices);
  });

  router.get('/:id/logs', auth, async (req: Request, res: Response): Promise<void> => {
    const { page, limit } = req.query as Record<string, string>;
    const result = await getLogs.execute({ clientId: req.params['id'] as string, page: page ? +page : 1, limit: limit ? +limit : 25 });
    res.json(result);
  });

  router.post('/', auth, async (req: Request, res: Response): Promise<void> => {
    const { firstName, lastName, email, phone, address, status } = req.body as {
      firstName?: string;
      lastName?: string;
      email?: string;
      phone?: string;
      address?: string;
      status?: 'active' | 'inactive';
    };

    if (!firstName || !lastName || !email || !phone) {
      res.status(400).json({
        error: 'Missing required fields: firstName, lastName, email, phone',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    const newClient: NewClient = {
      id: String(nextClientId++),
      name: `${firstName} ${lastName}`,
      firstName,
      lastName,
      email,
      phone,
      address: address ?? '',
      status: status ?? 'active',
      createdAt: new Date().toISOString(),
    };

    newClientsStore.push(newClient);
    incrementClients();
    res.status(201).json(newClient);
  });

  router.patch('/:id', auth, async (req: Request, res: Response): Promise<void> => {
    const id = parseInt(req.params['id'] as string);
    const { firstName, lastName, email, phone, address } = req.body as {
      firstName?: string;
      lastName?: string;
      email?: string;
      phone?: string;
      address?: string;
    };

    const existing = newClientsStore.find((c) => parseInt(c.id) === id);
    if (existing) {
      if (firstName !== undefined) existing.firstName = firstName;
      if (lastName !== undefined) existing.lastName = lastName;
      if (email !== undefined) existing.email = email;
      if (phone !== undefined) existing.phone = phone;
      if (address !== undefined) existing.address = address;
      if (firstName !== undefined || lastName !== undefined) {
        existing.name = `${existing.firstName} ${existing.lastName}`;
      }
      res.json(existing);
      return;
    }

    res.status(404).json({ error: 'Client not found', code: 'CLIENT_NOT_FOUND' });
  });

  router.get('/:id/documents', auth, async (req: Request, res: Response): Promise<void> => {
    const clientId = parseInt(req.params['id'] as string);
    res.json(documentsStore[clientId] ?? []);
  });

  router.post('/:id/documents', auth, async (req: Request, res: Response): Promise<void> => {
    const clientId = parseInt(req.params['id'] as string);
    const { name, size } = req.body as { name?: string; size?: number };

    if (!name || size === undefined) {
      res.status(400).json({ error: 'Missing required fields: name, size', code: 'VALIDATION_ERROR' });
      return;
    }

    const doc: ClientDoc = {
      id: nextDocId++,
      name,
      size,
      uploadedAt: new Date().toISOString(),
      url: `/files/${name}`,
    };

    if (!documentsStore[clientId]) documentsStore[clientId] = [];
    documentsStore[clientId].push(doc);
    res.status(201).json(doc);
  });

  router.patch('/:id/status', auth, async (req: Request, res: Response): Promise<void> => {
    const id = parseInt(req.params['id'] as string);
    const { status } = req.body as { status?: 'active' | 'inactive' | 'blocked' };

    const existing = newClientsStore.find((c) => parseInt(c.id) === id);
    if (existing) {
      if (status !== undefined) existing.status = status as 'active' | 'inactive';
      res.json(existing);
      return;
    }

    res.status(404).json({ error: 'Client not found', code: 'CLIENT_NOT_FOUND' });
  });

  // Services CRUD
  router.post('/:id/services', auth, async (req: Request, res: Response): Promise<void> => {
    const clientId = parseInt(req.params['id'] as string);
    const { type, plan, ipAddress, status, startDate } = req.body as {
      type?: string; plan?: string; ipAddress?: string; status?: string; startDate?: string;
    };

    if (!type || !plan) {
      res.status(400).json({ error: 'Missing required fields: type, plan', code: 'VALIDATION_ERROR' });
      return;
    }

    const service: Service = {
      id: nextServiceId++,
      type,
      plan,
      ipAddress: ipAddress ?? null,
      status: status ?? 'active',
      startDate: startDate ?? new Date().toISOString().split('T')[0],
      endDate: null,
    };

    if (!servicesOverrideStore[clientId]) servicesOverrideStore[clientId] = [];
    servicesOverrideStore[clientId].push(service);
    res.status(201).json(service);
  });

  router.patch('/:id/services/:serviceId', auth, async (req: Request, res: Response): Promise<void> => {
    const clientId = parseInt(req.params['id'] as string);
    const serviceId = parseInt(req.params['serviceId'] as string);
    const updates = req.body as Partial<Service>;

    const services = servicesOverrideStore[clientId] ?? [];
    const service = services.find((s) => s.id === serviceId);
    if (!service) {
      res.status(404).json({ error: 'Service not found', code: 'SERVICE_NOT_FOUND' });
      return;
    }

    if (updates.type !== undefined) service.type = updates.type;
    if (updates.plan !== undefined) service.plan = updates.plan;
    if (updates.ipAddress !== undefined) service.ipAddress = updates.ipAddress;
    if (updates.status !== undefined) service.status = updates.status;
    if (updates.endDate !== undefined) service.endDate = updates.endDate;

    res.json(service);
  });

  router.delete('/:id/services/:serviceId', auth, async (req: Request, res: Response): Promise<void> => {
    const clientId = parseInt(req.params['id'] as string);
    const serviceId = parseInt(req.params['serviceId'] as string);

    const services = servicesOverrideStore[clientId] ?? [];
    const index = services.findIndex((s) => s.id === serviceId);
    if (index === -1) {
      res.status(404).json({ error: 'Service not found', code: 'SERVICE_NOT_FOUND' });
      return;
    }

    services.splice(index, 1);
    res.status(204).send();
  });

  // Files store and endpoints
  interface ClientFile {
    id: number;
    name: string;
    size: number;
    uploadedAt: string;
  }

  const filesStore: Record<number, ClientFile[]> = {
    1: [
      { id: 1, name: 'foto_antena.jpg', size: 204800, uploadedAt: '2024-02-10T09:00:00.000Z' },
      { id: 2, name: 'mapa_ubicacion.png', size: 512000, uploadedAt: '2024-02-11T14:30:00.000Z' },
    ],
  };
  let nextFileId = 200;

  router.get('/:id/files', auth, async (req: Request, res: Response): Promise<void> => {
    const clientId = parseInt(req.params['id'] as string);
    res.json(filesStore[clientId] ?? []);
  });

  router.post('/:id/files', auth, async (req: Request, res: Response): Promise<void> => {
    const clientId = parseInt(req.params['id'] as string);
    const { name, size } = req.body as { name?: string; size?: number };

    if (!name || size === undefined) {
      res.status(400).json({ error: 'Missing required fields: name, size', code: 'VALIDATION_ERROR' });
      return;
    }

    const file: ClientFile = {
      id: nextFileId++,
      name,
      size,
      uploadedAt: new Date().toISOString(),
    };

    if (!filesStore[clientId]) filesStore[clientId] = [];
    filesStore[clientId].push(file);
    res.status(201).json(file);
  });

  return router;
}
