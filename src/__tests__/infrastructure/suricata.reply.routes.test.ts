/**
 * suricata-tickets-mirror (Phase E, task E.3, spec suricata-ticket-reply
 * REPLY-1..6, design D4/D10) — supertest over `composeSuricataModule`'s
 * `POST /tickets/:id/reply`, with REAL `ReplyToSuricataTicket` + InMemory
 * adapters (repo convention: never mock Prisma, never mock the use case) and
 * a `FakeSuricataReply` spy standing in for the port. RBAC harness molde
 * `store.routes.test.ts` (EchoAuthProvider + in-memory RBAC pivot repos).
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { composeSuricataModule } from '@infrastructure/http/composeSuricataModule';
import { requirePermission } from '@infrastructure/http/middleware/requirePermission';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { ReplyToSuricataTicket } from '@application/use-cases/suricata/ReplyToSuricataTicket';
import { InMemorySuricataTicketRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataTicketRepository';
import { InMemorySuricataReplyAuditRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataReplyAuditRepository';
import { InMemorySuricataMessageRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataMessageRepository';
import { InMemorySuricataAttachmentRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataAttachmentRepository';
import { InMemorySuricataAreaRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataAreaRepository';
import { InMemorySuricataVerdictRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataVerdictRepository';
import { InMemoryFeatureFlagRepository } from '@infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { ListSuricataTickets } from '@application/use-cases/suricata/ListSuricataTickets';
import { GetSuricataTicketDetail } from '@application/use-cases/suricata/GetSuricataTicketDetail';
import { ComputeSuricataKpis } from '@application/use-cases/suricata/ComputeSuricataKpis';
import { SetSuricataAssignee } from '@application/use-cases/suricata/SetSuricataAssignee';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';
import { FakeSuricataReply } from '../helpers/FakeSuricataReply';
import { UnavailableSuricataReplyPort } from '@infrastructure/adapters/suricata/UnavailableSuricataReplyPort';
import { computeSuricataReplyConfirmation } from '@domain/entities/suricataReplyConfirmation';
import { SuricataSessionBusyError, SuricataAuthError } from '@domain/errors/suricata';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';
import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import type { SuricataReplyPort } from '@domain/ports/SuricataReplyPort';

const FLAG_KEY = 'suricata-reply-enabled';

/** token IS the userId (echoed), molde store.routes.test.ts. */
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

interface BuildAppOpts {
  flagEnabled?: boolean;
  replyPort?: SuricataReplyPort;
}

async function buildApp(opts: BuildAppOpts = {}) {
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

  const replyRole = await roleRepo.create({ code: 'suricata_replier', label: 'Suricata Replier', isSystem: false });
  const replyPerm = await permRepo.seed({ moduleCode: 'suricata', action: 'reply' });
  await rolePermRepo.grant(replyRole.id, replyPerm.id);

  const pwHash = await hasher.hash('pw');
  const mkUser = (login: string) =>
    userRepo.create({ name: login, email: `${login}@x.com`, login, passwordHash: pwHash, status: 'active' });

  const replyUser = await mkUser('replier');
  await userRoleRepo.assign(replyUser.id, replyRole.id);
  const noPermUser = await mkUser('noperm');

  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  const tickets = new InMemorySuricataTicketRepository();
  const audits = new InMemorySuricataReplyAuditRepository();
  const featureFlags = new InMemoryFeatureFlagRepository();
  if (opts.flagEnabled !== false) featureFlags.seed(FLAG_KEY, true);
  const replyPort = opts.replyPort ?? new FakeSuricataReply();

  const replyToSuricataTicket = new ReplyToSuricataTicket(tickets, audits, replyPort);

  // Fase F — deps del panel read/assignee, no ejercitadas por ESTE archivo
  // (ver `suricata.routes.test.ts`), pero requeridas por `ComposeSuricataModuleDeps`.
  const messages = new InMemorySuricataMessageRepository();
  const attachments = new InMemorySuricataAttachmentRepository();
  const areaRepo = new InMemorySuricataAreaRepository();
  const verdicts = new InMemorySuricataVerdictRepository();
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
      // stateless en tests, molde newsMedia.routes.test.ts.
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

  return { app, tickets, audits, featureFlags, replyUserId: replyUser.id, noPermUserId: noPermUser.id };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

async function seedTicket(tickets: InMemorySuricataTicketRepository, externalId = 'ext-1') {
  return tickets.upsertByExternalId({
    externalId,
    subject: 'No tengo internet',
    status: 'abierto',
    priority: 'alta',
    areaId: null,
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

describe('POST /api/suricata/tickets/:id/reply', () => {
  it('REPLY-1 — no cookie -> 401, before any logic', async () => {
    const { app } = await buildApp();
    const res = await request(app).post('/api/suricata/tickets/any/reply').send({ body: 'hola', confirm: computeSuricataReplyConfirmation('hola') });
    expect(res.status).toBe(401);
  });

  it('REPLY-1 — missing suricata.reply permission -> 403 rejected BEFORE any Playwright action', async () => {
    const replyPort = new FakeSuricataReply();
    const { app, tickets, noPermUserId } = await buildApp({ replyPort });
    const ticket = await seedTicket(tickets);
    const body = 'hola';

    const res = await asUser(
      request(app).post(`/api/suricata/tickets/${ticket.id}/reply`),
      noPermUserId,
    ).send({ body, confirm: computeSuricataReplyConfirmation(body) });

    expect(res.status).toBe(403);
    expect(replyPort.calls).toHaveLength(0);
  });

  it('flag OFF -> 403 FEATURE_DISABLED, port never invoked', async () => {
    const replyPort = new FakeSuricataReply();
    const { app, tickets, replyUserId } = await buildApp({ flagEnabled: false, replyPort });
    const ticket = await seedTicket(tickets);
    const body = 'hola';

    const res = await asUser(
      request(app).post(`/api/suricata/tickets/${ticket.id}/reply`),
      replyUserId,
    ).send({ body, confirm: computeSuricataReplyConfirmation(body) });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FEATURE_DISABLED');
    expect(replyPort.calls).toHaveLength(0);
  });

  it('REPLY-2 — confirmation mismatch -> 400 REPLY_CONFIRMATION_MISMATCH, no send, no success audit', async () => {
    const replyPort = new FakeSuricataReply();
    const { app, tickets, audits, replyUserId } = await buildApp({ replyPort });
    const ticket = await seedTicket(tickets);

    const res = await asUser(
      request(app).post(`/api/suricata/tickets/${ticket.id}/reply`),
      replyUserId,
    ).send({ body: 'Ya revisamos tu reclamo', confirm: 'wrong-hash' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REPLY_CONFIRMATION_MISMATCH');
    expect(replyPort.calls).toHaveLength(0);
    expect((await audits.listByTicket(ticket.id)).some((a) => a.outcome === 'sent')).toBe(false);
  });

  it('REPLY-2/3 — matching confirm + valid ticket -> 202 with replyAuditId, audit outcome sent', async () => {
    const replyPort = new FakeSuricataReply();
    const { app, tickets, audits, replyUserId } = await buildApp({ replyPort });
    const ticket = await seedTicket(tickets);
    const body = 'Ya revisamos tu reclamo';

    const res = await asUser(
      request(app).post(`/api/suricata/tickets/${ticket.id}/reply`),
      replyUserId,
    ).send({ body, confirm: computeSuricataReplyConfirmation(body) });

    expect(res.status).toBe(202);
    expect(res.body.replyAuditId).toEqual(expect.any(String));
    expect(replyPort.calls).toEqual([{ externalId: ticket.externalId, body }]);
    const rows = await audits.listByTicket(ticket.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe('sent');
  });

  it('session busy -> 503 SURICATA_SESSION_BUSY + Retry-After: 30, audit outcome failed', async () => {
    const replyPort = new FakeSuricataReply(new SuricataSessionBusyError());
    const { app, tickets, audits, replyUserId } = await buildApp({ replyPort });
    const ticket = await seedTicket(tickets);
    const body = 'hola';

    const res = await asUser(
      request(app).post(`/api/suricata/tickets/${ticket.id}/reply`),
      replyUserId,
    ).send({ body, confirm: computeSuricataReplyConfirmation(body) });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SURICATA_SESSION_BUSY');
    expect(res.headers['retry-after']).toBe('30');
    const rows = await audits.listByTicket(ticket.id);
    expect(rows[0]?.outcome).toBe('failed');
  });

  it('auth/driver failure -> 502 SURICATA_UNAVAILABLE with replyAuditId, no false success', async () => {
    const replyPort = new FakeSuricataReply(new SuricataAuthError());
    const { app, tickets, audits, replyUserId } = await buildApp({ replyPort });
    const ticket = await seedTicket(tickets);
    const body = 'hola';

    const res = await asUser(
      request(app).post(`/api/suricata/tickets/${ticket.id}/reply`),
      replyUserId,
    ).send({ body, confirm: computeSuricataReplyConfirmation(body) });

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('SURICATA_UNAVAILABLE');
    const rows = await audits.listByTicket(ticket.id);
    expect(res.body.replyAuditId).toBe(rows[0]?.id);
    expect(rows[0]?.outcome).toBe('failed');
  });

  it('CONSERVATIVE GUARD — the real UnavailableSuricataReplyPort (what composeSuricataModule actually wires today) always fails closed', async () => {
    const { app, tickets, replyUserId } = await buildApp({ replyPort: new UnavailableSuricataReplyPort() });
    const ticket = await seedTicket(tickets);
    const body = 'hola';

    const res = await asUser(
      request(app).post(`/api/suricata/tickets/${ticket.id}/reply`),
      replyUserId,
    ).send({ body, confirm: computeSuricataReplyConfirmation(body) });

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('SURICATA_UNAVAILABLE');
  });

  it('unknown ticket -> 404, port never invoked', async () => {
    const replyPort = new FakeSuricataReply();
    const { app, replyUserId } = await buildApp({ replyPort });
    const body = 'hola';

    const res = await asUser(
      request(app).post('/api/suricata/tickets/ghost/reply'),
      replyUserId,
    ).send({ body, confirm: computeSuricataReplyConfirmation(body) });

    expect(res.status).toBe(404);
    expect(replyPort.calls).toHaveLength(0);
  });
});
