/**
 * suricata-tickets-mirror (Phase F, task F.3, spec `suricata-tickets-ui`
 * UI-1..UI-8, design D13) — supertest over `composeSuricataModule`'s panel
 * READ routes + assignment PATCH, with REAL use cases + InMemory adapters
 * (repo convention: never mock Prisma, never mock the use case). RBAC harness
 * molde `suricata.reply.routes.test.ts` (EchoAuthProvider + in-memory RBAC
 * pivot repos).
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { composeSuricataModule } from '@infrastructure/http/composeSuricataModule';
import { requirePermission } from '@infrastructure/http/middleware/requirePermission';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { ReplyToSuricataTicket } from '@application/use-cases/suricata/ReplyToSuricataTicket';
import { ListSuricataTickets } from '@application/use-cases/suricata/ListSuricataTickets';
import { GetSuricataTicketDetail } from '@application/use-cases/suricata/GetSuricataTicketDetail';
import { ComputeSuricataKpis } from '@application/use-cases/suricata/ComputeSuricataKpis';
import { SetSuricataAssignee } from '@application/use-cases/suricata/SetSuricataAssignee';
import { InMemorySuricataTicketRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataTicketRepository';
import { InMemorySuricataMessageRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataMessageRepository';
import { InMemorySuricataAttachmentRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataAttachmentRepository';
import { InMemorySuricataVerdictRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataVerdictRepository';
import { InMemorySuricataAreaRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataAreaRepository';
import { InMemorySuricataReplyAuditRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataReplyAuditRepository';
import { InMemoryFeatureFlagRepository } from '@infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';
import { FakeSuricataReply } from '../helpers/FakeSuricataReply';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';
import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';

/** token IS the userId (echoed), molde suricata.reply.routes.test.ts / store.routes.test.ts. */
class EchoAuthProvider implements AuthProvider {
  constructor(private readonly userRepo: RbacUserRepository) {}
  async login() {
    return {
      user: { id: 'x', username: 't', email: 't@t.com', role: 'admin' as const },
      cookieValue: 'x',
      cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 3600, path: '/' },
    };
  }
  logout() {
    return { cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 0, path: '/' } };
  }
  async getSession(token: string): Promise<User> {
    const user = await this.userRepo.findById(token);
    if (!user) return { id: token, username: token, email: `${token}@test.com`, role: 'admin' };
    return { id: user.id, username: user.login, email: user.email, role: 'admin' };
  }
}

async function buildApp() {
  const roleRepo = new InMemoryRbacRoleRepository();
  const userRoleRepo = new InMemoryRbacUserRoleRepository();
  const permRepo = new InMemoryRbacPermissionRepository();
  const rolePermRepo = new InMemoryRbacRolePermissionRepository();
  const hasher = new InMemoryPasswordHasher();
  const userRepo = new InMemoryRbacUserRepository(userRoleRepo, roleRepo);

  userRepo.listRolesForUser = async (userId: string) => {
    const roleIds = await userRoleRepo.listForUser(userId);
    const roles = await Promise.all(roleIds.map((id) => roleRepo.findById(id)));
    return roles.filter((r): r is NonNullable<typeof r> => r !== null);
  };
  userRepo.listPermissionsForUser = async (userId: string) => {
    const roleIds = await userRoleRepo.listForUser(userId);
    const perms: import('@domain/entities/rbac').RbacPermission[] = [];
    const allPerms = await permRepo.listAll();
    for (const roleId of roleIds) {
      const permIds = await rolePermRepo.listForRole(roleId);
      for (const permId of permIds) {
        const p = allPerms.find((ap) => ap.id === permId);
        if (p) perms.push(p);
      }
    }
    return perms;
  };

  const readRole = await roleRepo.create({ code: 'suricata_reader', label: 'Suricata Reader', isSystem: false });
  const readPerm = await permRepo.seed({ moduleCode: 'suricata', action: 'read' });
  await rolePermRepo.grant(readRole.id, readPerm.id);

  const manageRole = await roleRepo.create({ code: 'suricata_manager', label: 'Suricata Manager', isSystem: false });
  const managePerm = await permRepo.seed({ moduleCode: 'suricata', action: 'manage' });
  await rolePermRepo.grant(manageRole.id, readPerm.id);
  await rolePermRepo.grant(manageRole.id, managePerm.id);

  const pwHash = await hasher.hash('pw');
  const mkUser = (login: string) =>
    userRepo.create({ name: login, email: `${login}@x.com`, login, passwordHash: pwHash, status: 'active' });

  const readerUser = await mkUser('reader');
  await userRoleRepo.assign(readerUser.id, readRole.id);
  const managerUser = await mkUser('manager');
  await userRoleRepo.assign(managerUser.id, manageRole.id);
  const noPermUser = await mkUser('noperm');

  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  const tickets = new InMemorySuricataTicketRepository();
  const messages = new InMemorySuricataMessageRepository();
  const attachments = new InMemorySuricataAttachmentRepository();
  const verdicts = new InMemorySuricataVerdictRepository();
  const areaRepo = new InMemorySuricataAreaRepository();
  const audits = new InMemorySuricataReplyAuditRepository();
  const featureFlags = new InMemoryFeatureFlagRepository();

  const replyToSuricataTicket = new ReplyToSuricataTicket(tickets, audits, new FakeSuricataReply());
  const listSuricataTickets = new ListSuricataTickets(tickets, verdicts, areaRepo, userRepo);
  const getSuricataTicketDetail = new GetSuricataTicketDetail(tickets, messages, attachments, verdicts, areaRepo, userRepo);
  const computeSuricataKpis = new ComputeSuricataKpis(tickets, verdicts);
  const setSuricataAssignee = new SetSuricataAssignee(tickets, userRepo);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(
    '/api/suricata',
    composeSuricataModule({
      authAdapter: new EchoAuthProvider(userRepo),
      sessionRepo: undefined as unknown as import('@domain/ports/SessionRepository').SessionRepository,
      requirePerm,
      replyToSuricataTicket,
      featureFlags,
      listSuricataTickets,
      getSuricataTicketDetail,
      computeSuricataKpis,
      setSuricataAssignee,
      areaRepo,
    }),
  );
  app.use(errorHandler);

  return { app, tickets, messages, attachments, verdicts, areaRepo, userRepo, readerUserId: readerUser.id, managerUserId: managerUser.id, noPermUserId: noPermUser.id };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

async function seedTicket(tickets: InMemorySuricataTicketRepository, over: { externalId?: string; areaId?: string | null } = {}) {
  return tickets.upsertByExternalId({
    externalId: over.externalId ?? 'ext-1',
    subject: 'No tengo internet',
    status: 'abierto',
    priority: 'alta',
    areaId: over.areaId ?? null,
    customerName: 'Juan Perez',
    customerEmail: 'juan@example.com',
    customerPhone: null,
    externalClientRef: null,
    clientId: null,
    openedAt: '2026-09-01T09:00:00.000Z',
    lastMessageAt: '2026-09-01T09:00:00.000Z',
    contentHash: 'hash-v1',
    syncedAt: '2026-09-01T09:00:00.000Z',
  });
}

describe('GET /api/suricata/tickets', () => {
  it('no cookie -> 401', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/suricata/tickets');
    expect(res.status).toBe(401);
  });

  it('missing suricata.read -> 403', async () => {
    const { app, noPermUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/suricata/tickets'), noPermUserId);
    expect(res.status).toBe(403);
  });

  it('UI-1 — suricata.read lists mirrored tickets with filters applied', async () => {
    const { app, tickets, readerUserId } = await buildApp();
    await seedTicket(tickets, { externalId: 'ext-1' });
    await seedTicket(tickets, { externalId: 'ext-2' });

    const res = await asUser(request(app).get('/api/suricata/tickets'), readerUserId);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.data).toHaveLength(2);

    const filtered = await asUser(request(app).get('/api/suricata/tickets?status=cerrado'), readerUserId);
    expect(filtered.status).toBe(200);
    expect(filtered.body.total).toBe(0);
  });

  it('malformed botState -> 400 VALIDATION_ERROR, never 500', async () => {
    const { app, readerUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/suricata/tickets?botState=nope'), readerUserId);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/suricata/tickets/:id', () => {
  it('missing suricata.read -> 403', async () => {
    const { app, tickets, noPermUserId } = await buildApp();
    const ticket = await seedTicket(tickets);
    const res = await asUser(request(app).get(`/api/suricata/tickets/${ticket.id}`), noPermUserId);
    expect(res.status).toBe(403);
  });

  it('UI-2 — returns the mirror-only detail', async () => {
    const { app, tickets, readerUserId } = await buildApp();
    const ticket = await seedTicket(tickets);
    const res = await asUser(request(app).get(`/api/suricata/tickets/${ticket.id}`), readerUserId);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(ticket.id);
    expect(res.body.botState).toBe('sin_analizar');
    expect(res.body.messages).toEqual([]);
  });

  it('unknown ticket -> 404', async () => {
    const { app, readerUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/suricata/tickets/ghost'), readerUserId);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SURICATA_TICKET_NOT_FOUND');
  });
});

describe('GET /api/suricata/areas', () => {
  it('missing suricata.read -> 403', async () => {
    const { app, noPermUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/suricata/areas'), noPermUserId);
    expect(res.status).toBe(403);
  });

  it('UI-1 — lists the area catalog', async () => {
    const { app, areaRepo, readerUserId } = await buildApp();
    await areaRepo.upsertMany([{ externalId: 'a1', name: 'Facturación', syncedAt: '2026-09-01T00:00:00.000Z' }]);
    const res = await asUser(request(app).get('/api/suricata/areas'), readerUserId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: expect.any(String), name: 'Facturación', active: true }]);
  });
});

describe('GET /api/suricata/kpis', () => {
  it('missing suricata.read -> 403', async () => {
    const { app, noPermUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/suricata/kpis'), noPermUserId);
    expect(res.status).toBe(403);
  });

  it('UI-6 — aggregate KPIs, computed by hand against seeded data', async () => {
    const { app, tickets, verdicts, readerUserId } = await buildApp();
    const t1 = await seedTicket(tickets, { externalId: 'ext-1' });
    await seedTicket(tickets, { externalId: 'ext-2' });
    await verdicts.create({ ticketId: t1.id, resuelto: true, analisis: 'ok', motivo: null, respuestaSugerida: null, ticketContentHash: 'hash-v1', submittedBy: 'api-suricata' });

    const res = await asUser(request(app).get('/api/suricata/kpis'), readerUserId);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.resueltoBotPct).toBe(50);
    expect(res.body.sinVeredictoPct).toBe(50);
  });
});

describe('PATCH /api/suricata/tickets/:id/assignee', () => {
  it('no cookie -> 401', async () => {
    const { app } = await buildApp();
    const res = await request(app).patch('/api/suricata/tickets/any/assignee').send({ assigneeId: null });
    expect(res.status).toBe(401);
  });

  it('UI-8 — suricata.read alone is NOT enough to assign (requires suricata.manage)', async () => {
    const { app, tickets, readerUserId } = await buildApp();
    const ticket = await seedTicket(tickets);
    const res = await asUser(request(app).patch(`/api/suricata/tickets/${ticket.id}/assignee`), readerUserId).send({ assigneeId: null });
    expect(res.status).toBe(403);
  });

  it('UI-7 — suricata.manage assigns the ticket locally, never touching any Suricata port', async () => {
    const { app, tickets, managerUserId, userRepo } = await buildApp();
    const ticket = await seedTicket(tickets);
    const agent = await userRepo.create({ name: 'Ana', email: 'ana@x.com', login: 'ana', passwordHash: 'h', status: 'active' });

    const res = await asUser(request(app).patch(`/api/suricata/tickets/${ticket.id}/assignee`), managerUserId).send({ assigneeId: agent.id });
    expect(res.status).toBe(200);
    expect(res.body.assigneeId).toBe(agent.id);

    const reloaded = await tickets.findById(ticket.id);
    expect(reloaded?.assigneeId).toBe(agent.id);
  });

  it('clears the assignment with assigneeId: null', async () => {
    const { app, tickets, managerUserId } = await buildApp();
    const ticket = await seedTicket(tickets);
    await tickets.setAssignee(ticket.id, 'some-user');

    const res = await asUser(request(app).patch(`/api/suricata/tickets/${ticket.id}/assignee`), managerUserId).send({ assigneeId: null });
    expect(res.status).toBe(200);
    expect(res.body.assigneeId).toBeNull();
  });

  it('unknown ticket -> 404', async () => {
    const { app, managerUserId } = await buildApp();
    const res = await asUser(request(app).patch('/api/suricata/tickets/ghost/assignee'), managerUserId).send({ assigneeId: null });
    expect(res.status).toBe(404);
  });
});
