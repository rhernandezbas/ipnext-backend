/**
 * #85 — archive + hard-delete + exclude-archived-from-lists route tests.
 * RED: fails until routes are wired.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';

import { InMemoryTicketRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketRepository';
import { InMemoryTicketStatusRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketStatusRepository';
import { InMemoryTicketAreaCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketAreaCatalogRepository';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';

import { ListTickets } from '@application/use-cases/ListTickets';
import { GetTicketStats } from '@application/use-cases/GetTicketStats';
import { CreateTicket } from '@application/use-cases/CreateTicket';
import { GetTicket } from '@application/use-cases/GetTicket';
import { UpdateTicketStatus } from '@application/use-cases/UpdateTicketStatus';
import { UpdateTicket } from '@application/use-cases/UpdateTicket';
import { CloseTicket } from '@application/use-cases/CloseTicket';
import { ArchiveTicket } from '@application/use-cases/ArchiveTicket';
import { DeleteTicketHard } from '@application/use-cases/DeleteTicketHard';
import { createTicketsRouter } from '@infrastructure/http/routes/tickets.routes';
import { requirePermission } from '@infrastructure/http/middleware/requirePermission';

import type { JwtAuthAdapter } from '@infrastructure/adapters/jwt/JwtAuthAdapter';
import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import type { RbacUser } from '@domain/entities/rbac';

// Simple auth stub that returns the token value as the user id
// so we can use cookie value as user id for RBAC checks.
function buildEchoAuthProvider() {
  return {
    getSession: jest.fn().mockImplementation(async (token: string) => ({
      id: token,
      email: `${token}@test.com`,
      role: 'admin',
    })),
  } as unknown as JwtAuthAdapter;
}

function buildRbacUserRepo(ids: string[]): RbacUserRepository {
  const pool = new Set(ids);
  return {
    findById: async (id: string): Promise<RbacUser | null> =>
      pool.has(id) ? ({ id } as unknown as RbacUser) : null,
  } as unknown as RbacUserRepository;
}

interface Fixture {
  app: express.Express;
  repo: InMemoryTicketRepository;
  statusRepo: InMemoryTicketStatusRepository;
  areaRepo: InMemoryTicketAreaCatalogRepository;
  closePermUserId: string;
  deleteHardPermUserId: string;
  superAdminUserId: string;
  noPermUserId: string;
}

async function buildApp(): Promise<Fixture> {
  const roleRepo = new InMemoryRbacRoleRepository();
  const userRoleRepo = new InMemoryRbacUserRoleRepository();
  const permRepo = new InMemoryRbacPermissionRepository();
  const rolePermRepo = new InMemoryRbacRolePermissionRepository();
  const hasher = new InMemoryPasswordHasher();
  const rbacUserRepo = new InMemoryRbacUserRepository(userRoleRepo, roleRepo);

  rbacUserRepo.listRolesForUser = async (userId: string) => {
    const roleIds = await userRoleRepo.listForUser(userId);
    const roles = await Promise.all(roleIds.map((id) => roleRepo.findById(id)));
    return roles.filter((r): r is NonNullable<typeof r> => r !== null);
  };
  rbacUserRepo.listPermissionsForUser = async (userId: string) => {
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

  // Roles
  const closerRole = await roleRepo.create({ code: 'ticket_closer', label: 'Ticket Closer', isSystem: false });
  const deleterRole = await roleRepo.create({ code: 'ticket_deleter', label: 'Ticket Deleter', isSystem: false });
  const superAdminRole = await roleRepo.create({ code: 'super_admin', label: 'Super Admin', isSystem: true });

  // Permissions
  const closePerm = await permRepo.seed({ moduleCode: 'tickets', action: 'close' });
  const deleteHardPerm = await permRepo.seed({ moduleCode: 'tickets', action: 'delete_hard' });

  await rolePermRepo.grant(closerRole.id, closePerm.id);
  await rolePermRepo.grant(deleterRole.id, deleteHardPerm.id);

  const pwHash = await hasher.hash('pw');
  const mkUser = (login: string) =>
    rbacUserRepo.create({ name: login, email: `${login}@x.com`, login, passwordHash: pwHash, status: 'active' });

  const closePermUser = await mkUser('closer');
  await userRoleRepo.assign(closePermUser.id, closerRole.id);

  const deleteHardPermUser = await mkUser('deleter');
  await userRoleRepo.assign(deleteHardPermUser.id, deleterRole.id);

  const superAdminUser = await mkUser('superadmin');
  await userRoleRepo.assign(superAdminUser.id, superAdminRole.id);

  const noPermUser = await mkUser('noperm');

  // Repos
  const repo = new InMemoryTicketRepository();
  repo.seedAdmins([
    { id: closePermUser.id, name: 'Closer User' },
    { id: deleteHardPermUser.id, name: 'Deleter User' },
    { id: superAdminUser.id, name: 'Super Admin User' },
    { id: noPermUser.id, name: 'No Perm User' },
  ]);
  const statusRepo = new InMemoryTicketStatusRepository();
  await statusRepo.create({ name: 'open', color: '#22c55e', weight: 0 });
  await statusRepo.create({ name: 'closed', color: '#6b7280', weight: 2 });

  const areaRepo = new InMemoryTicketAreaCatalogRepository();
  repo.seedAreas(areaRepo);

  // Use cases
  const listTickets = new ListTickets(repo);
  const getStats = new GetTicketStats(repo);
  const createTicket = new CreateTicket(repo);
  const getTicket = new GetTicket(repo);
  const updateStatus = new UpdateTicketStatus(repo);
  const updateTicket = new UpdateTicket(repo);
  const closeTicket = new CloseTicket(repo, statusRepo);
  const archiveTicket = new ArchiveTicket(repo, statusRepo);
  const deleteTicketHard = new DeleteTicketHard(repo);

  const authProvider = buildEchoAuthProvider();
  const ticketRbacUserRepo = buildRbacUserRepo([
    closePermUser.id, deleteHardPermUser.id, superAdminUser.id, noPermUser.id,
  ]);

  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  app.use(
    '/api/tickets',
    createTicketsRouter(
      listTickets,
      getStats,
      createTicket,
      getTicket,
      updateStatus,
      updateTicket,
      closeTicket,
      statusRepo,
      authProvider,
      ticketRbacUserRepo,
      undefined, // createTaskFromTicket
      undefined, // taskRepo
      undefined, // stageRepo
      areaRepo,
      archiveTicket,
      deleteTicketHard,
      rbacUserRepo, // rbacUserRepo for requirePermission
    ),
  );

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return {
    app,
    repo,
    statusRepo,
    areaRepo,
    closePermUserId: closePermUser.id,
    deleteHardPermUserId: deleteHardPermUser.id,
    superAdminUserId: superAdminUser.id,
    noPermUserId: noPermUser.id,
  };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

// ─── POST /api/tickets/:id/archive ────────────────────────────────────────────

describe('POST /api/tickets/:id/archive (#85)', () => {
  it('returns 200 with archivedAt set for a CLOSED ticket + tickets.close permission', async () => {
    const fx = await buildApp();
    // Create and close a ticket
    const ticket = await fx.repo.create({ subject: 'T1', description: 'd1' });
    await fx.repo.close(ticket.id, 'closed');

    const res = await asUser(
      request(fx.app).post(`/api/tickets/${ticket.id}/archive`),
      fx.closePermUserId,
    );
    expect(res.status).toBe(200);
    expect(res.body.archivedAt).not.toBeNull();
  });

  it('returns 422 TICKET_NOT_CLOSED for an OPEN ticket', async () => {
    const fx = await buildApp();
    const ticket = await fx.repo.create({ subject: 'T2', description: 'd2' });

    const res = await asUser(
      request(fx.app).post(`/api/tickets/${ticket.id}/archive`),
      fx.closePermUserId,
    );
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TICKET_NOT_CLOSED');
  });

  it('returns 403 PERMISSION_DENIED without tickets.close permission', async () => {
    const fx = await buildApp();
    const ticket = await fx.repo.create({ subject: 'T3', description: 'd3' });
    await fx.repo.close(ticket.id, 'closed');

    const res = await asUser(
      request(fx.app).post(`/api/tickets/${ticket.id}/archive`),
      fx.noPermUserId,
    );
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });

  it('returns 404 for a nonexistent ticket', async () => {
    const fx = await buildApp();
    const res = await asUser(
      request(fx.app).post('/api/tickets/nonexistent/archive'),
      fx.closePermUserId,
    );
    expect(res.status).toBe(404);
  });
});

// ─── GET /api/tickets — archived filtering ────────────────────────────────────

describe('GET /api/tickets — archived filtering (#85)', () => {
  it('default: does NOT include archived tickets', async () => {
    const fx = await buildApp();
    const t1 = await fx.repo.create({ subject: 'Active', description: 'd' });
    const t2 = await fx.repo.create({ subject: 'Archived', description: 'd' });
    await fx.repo.close(t2.id, 'closed');
    await fx.repo.archive(t2.id);

    const res = await asUser(request(fx.app).get('/api/tickets'), fx.closePermUserId);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].id).toBe(t1.id);
  });

  it('?archived=true returns ONLY archived tickets', async () => {
    const fx = await buildApp();
    await fx.repo.create({ subject: 'Active', description: 'd' });
    const t2 = await fx.repo.create({ subject: 'Archived', description: 'd' });
    await fx.repo.close(t2.id, 'closed');
    await fx.repo.archive(t2.id);

    const res = await asUser(request(fx.app).get('/api/tickets?archived=true'), fx.closePermUserId);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].id).toBe(t2.id);
  });
});

// ─── DELETE /api/tickets/:id/hard ─────────────────────────────────────────────

describe('DELETE /api/tickets/:id/hard (#85)', () => {
  it('super_admin can hard-delete → 204, then GET returns 404', async () => {
    const fx = await buildApp();
    const ticket = await fx.repo.create({ subject: 'T4', description: 'd4' });

    const res = await asUser(
      request(fx.app).delete(`/api/tickets/${ticket.id}/hard`),
      fx.superAdminUserId,
    );
    expect(res.status).toBe(204);

    // Ticket is gone
    const found = await fx.repo.getById(ticket.id);
    expect(found).toBeNull();
  });

  it('returns 403 without tickets.delete_hard permission', async () => {
    const fx = await buildApp();
    const ticket = await fx.repo.create({ subject: 'T5', description: 'd5' });

    const res = await asUser(
      request(fx.app).delete(`/api/tickets/${ticket.id}/hard`),
      fx.noPermUserId,
    );
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });
});
