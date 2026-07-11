import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { z } from 'zod';
import { ListClients } from '@application/use-cases/ListClients';
import { GetClientDetail } from '@application/use-cases/GetClientDetail';
import { GetClientContracts } from '@application/use-cases/GetClientContracts';
import { GetClientInvoices } from '@application/use-cases/GetClientInvoices';
import { GetClientLogs } from '@application/use-cases/GetClientLogs';
import { CreateCustomer } from '@application/use-cases/CreateCustomer';
import { GetClientStats } from '@application/use-cases/GetClientStats';
import { DeleteCustomer } from '@application/use-cases/DeleteCustomer';
import { UpdateClientLocation } from '@application/use-cases/UpdateClientLocation';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { JwtAuthAdapter } from '../../adapters/jwt/JwtAuthAdapter';
import { ClientNotFoundError, SplynxUnavailableError } from '@domain/errors';
import { InvalidLocationError } from '@domain/errors/geolocation';
import { deriveTechnology } from '@application/use-cases/deriveTechnology';
import { mapContractStatus } from '@application/use-cases/mapContractStatus';
import { toInvoiceDto } from '@application/dto/invoice.dto';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import { incrementClients, decrementClients } from '../../adapters/in-memory/shared-stores';

/** Factory matching `requirePerm` exported from app.ts (DIP-clean injection). */
type RequirePerm = (module: RbacModuleCode, action: PermissionAction) => RequestHandler;

/** Zod schema for PATCH /clients/:id — whitelist ONLY Prominense-owned GPS fields. */
const UpdateClientLocationSchema = z.object({
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  plusCode: z.string().nullable().optional(),
});

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

// In-memory store for contract mutations
interface Contract {
  id: number;
  type: string;
  plan: string;
  ipAddress: string | null;
  status: string;
  startDate: string;
  endDate: string | null;
}

const contractsOverrideStore: Record<number, Contract[]> = {};
let nextContractId = 500;

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
  getContracts: GetClientContracts,
  getInvoices: GetClientInvoices,
  getLogs: GetClientLogs,
  authProvider: JwtAuthAdapter,
  createCustomer: CreateCustomer,
  getClientStats: GetClientStats,
  deleteCustomer: DeleteCustomer,
  updateClientLocation?: UpdateClientLocation,
  requirePerm?: RequirePerm,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider);
  const writePerm: RequestHandler = requirePerm ? requirePerm('clients', 'write') : (_req, _res, next) => next();

  // IMPORTANT: /stats MUST be declared before /:id so the catch-all does not
  // swallow it (Express matches in declaration order).
  router.get('/stats', auth, async (_req: Request, res: Response): Promise<void> => {
    try {
      const stats = await getClientStats.execute();
      res.json(stats);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load client stats';
      res.status(500).json({ error: message, code: 'INTERNAL_ERROR' });
    }
  });

  router.get('/', auth, async (req: Request, res: Response): Promise<void> => {
    try {
      const { page, limit, search, status } = req.query as Record<string, string>;
      const result = await listClients.execute({ page: page ? +page : 1, limit: limit ? +limit : 25, search, status });
      // Compute totalPages for the frontend — derived from total / limit so the
      // pagination component can render N pages instead of just prev/next buttons.
      const totalPages = result.limit > 0 ? Math.max(1, Math.ceil(result.total / result.limit)) : 1;
      res.json({ ...result, totalPages });
    } catch (err) {
      if (err instanceof SplynxUnavailableError) {
        res.status(503).json({ error: 'Clients backend unavailable', code: 'CLIENTS_UNAVAILABLE' });
        return;
      }
      res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    }
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

  router.get('/:id', auth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
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
        // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
        next(err);
      }
    }
  });

  router.delete('/:id', auth, async (req: Request, res: Response): Promise<void> => {
    const id = req.params['id'] as string;
    try {
      const deleted = await deleteCustomer.execute(id);
      if (!deleted) {
        res.status(404).json({ error: 'Client not found', code: 'CLIENT_NOT_FOUND' });
        return;
      }
      decrementClients();
      res.status(204).send();
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      // FK constraint violation. P2003 = explicit FK; P2014 = required-relation
      // violation Prisma raises when a cascade hits a RESTRICT'd child. Fix #6:
      // deleting a client cascades Contract → CLIENTE StockLocation, but
      // InventoryAsset.currentLocationId is onDelete: Restrict, so an installed
      // asset blocks the delete. Surface a clear 409 instead of a 500.
      if (code === 'P2003' || code === 'P2014') {
        res.status(409).json({
          error: 'Cannot delete: client is referenced by other records (tasks, contracts, invoices, or installed inventory/assets). Detach or return those first.',
          code: 'CLIENT_HAS_REFERENCES',
        });
        return;
      }
      const message = err instanceof Error ? err.message : 'Failed to delete client';
      res.status(500).json({ error: message, code: 'INTERNAL_ERROR' });
    }
  });

  router.get('/:id/contracts', auth, async (req: Request, res: Response): Promise<void> => {
    const contracts = await getContracts.execute(req.params['id'] as string);
    // Apply deriveTechnology + mapContractStatus at the output layer.
    // - technology: manual value wins, else derived from plan.
    // - status: raw GR estado ("Vigente"/"Baja"/…) → canonical enum the FE understands
    //   (idempotent for already-canonical values; same computed-on-read convention).
    // The raw stored values on the entity are NOT mutated.
    const mapped = contracts.map((c) => ({
      ...c,
      status: mapContractStatus(c.status),
      technology: deriveTechnology(c.technology, c.plan),
    }));
    res.json(mapped);
  });

  router.get('/:id/invoices', auth, async (req: Request, res: Response): Promise<void> => {
    const invoices = await getInvoices.execute(req.params['id'] as string);
    // Map to the stable InvoiceDto contract — never leak the raw domain entity (AD-6).
    res.json(invoices.map(toInvoiceDto));
  });

  router.get('/:id/logs', auth, async (req: Request, res: Response): Promise<void> => {
    const { page, limit } = req.query as Record<string, string>;
    const result = await getLogs.execute({ clientId: req.params['id'] as string, page: page ? +page : 1, limit: limit ? +limit : 25 });
    res.json(result);
  });

  router.post('/', auth, async (req: Request, res: Response): Promise<void> => {
    const { firstName, lastName, email, phone, address, city, country, status, login, splynxId } = req.body as {
      firstName?: string;
      lastName?: string;
      email?: string;
      phone?: string;
      address?: string;
      city?: string;
      country?: string;
      status?: 'active' | 'inactive' | 'blocked' | 'new';
      login?: string;
      splynxId?: string;
    };

    if (!firstName || !lastName || !email || !phone) {
      res.status(400).json({
        error: 'Missing required fields: firstName, lastName, email, phone',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    try {
      const customer = await createCustomer.execute({
        firstName,
        lastName,
        email,
        phone,
        address,
        city,
        country,
        status,
        login,
        splynxId,
      });
      incrementClients();
      res.status(201).json(customer);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      // Prisma P2002 — unique constraint (email or login already used)
      if (code === 'P2002') {
        res.status(409).json({
          error: 'A client with that email or login already exists',
          code: 'DUPLICATE_CLIENT',
        });
        return;
      }
      const message = err instanceof Error ? err.message : 'Failed to create client';
      res.status(500).json({ error: message, code: 'INTERNAL_ERROR' });
    }
  });

  /**
   * PATCH /clients/:id — update Prominense-owned GPS location.
   * Whitelisted body: lat, lng, plusCode. Any other fields are ignored by Zod.
   * Gate: clients.write.
   */
  router.patch('/:id', auth, writePerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!updateClientLocation) {
      res.status(501).json({ error: 'Not implemented', code: 'NOT_IMPLEMENTED' });
      return;
    }
    const parsed = UpdateClientLocationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      const customer = await updateClientLocation.execute({
        id: req.params['id'] as string,
        lat: parsed.data.lat,
        lng: parsed.data.lng,
        plusCode: parsed.data.plusCode,
      });
      res.json(customer);
    } catch (err) {
      if (err instanceof ClientNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof InvalidLocationError) {
        res.status(422).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
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

  // Contracts CRUD
  router.post('/:id/contracts', auth, async (req: Request, res: Response): Promise<void> => {
    const clientId = parseInt(req.params['id'] as string);
    const { type, plan, ipAddress, status, startDate } = req.body as {
      type?: string; plan?: string; ipAddress?: string; status?: string; startDate?: string;
    };

    if (!type || !plan) {
      res.status(400).json({ error: 'Missing required fields: type, plan', code: 'VALIDATION_ERROR' });
      return;
    }

    const contract: Contract = {
      id: nextContractId++,
      type,
      plan,
      ipAddress: ipAddress ?? null,
      status: status ?? 'active',
      startDate: startDate ?? new Date().toISOString().split('T')[0],
      endDate: null,
    };

    if (!contractsOverrideStore[clientId]) contractsOverrideStore[clientId] = [];
    contractsOverrideStore[clientId].push(contract);
    res.status(201).json(contract);
  });

  router.patch('/:id/contracts/:contractId', auth, async (req: Request, res: Response): Promise<void> => {
    const clientId = parseInt(req.params['id'] as string);
    const contractId = parseInt(req.params['contractId'] as string);
    const updates = req.body as Partial<Contract>;

    const contracts = contractsOverrideStore[clientId] ?? [];
    const contract = contracts.find((s) => s.id === contractId);
    if (!contract) {
      res.status(404).json({ error: 'Contract not found', code: 'CONTRACT_NOT_FOUND' });
      return;
    }

    if (updates.type !== undefined) contract.type = updates.type;
    if (updates.plan !== undefined) contract.plan = updates.plan;
    if (updates.ipAddress !== undefined) contract.ipAddress = updates.ipAddress;
    if (updates.status !== undefined) contract.status = updates.status;
    if (updates.endDate !== undefined) contract.endDate = updates.endDate;

    res.json(contract);
  });

  router.delete('/:id/contracts/:contractId', auth, async (req: Request, res: Response): Promise<void> => {
    const clientId = parseInt(req.params['id'] as string);
    const contractId = parseInt(req.params['contractId'] as string);

    const contracts = contractsOverrideStore[clientId] ?? [];
    const index = contracts.findIndex((s) => s.id === contractId);
    if (index === -1) {
      res.status(404).json({ error: 'Contract not found', code: 'CONTRACT_NOT_FOUND' });
      return;
    }

    contracts.splice(index, 1);
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
