/**
 * suricata-tickets-mirror (fix wave, 2026-09-13) — supertest sobre
 * `POST /api/suricata/sync` ("sincronizar ahora" manual). Mockea
 * `getSuricataSyncScheduler` (el singleton que `main.ts` arranca) en vez de
 * construir un scheduler real -- este endpoint es puro wiring, la lógica de
 * `runOnce()` ya está cubierta por `SuricataSyncScheduler.test.ts`.
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

jest.mock('@infrastructure/scheduling/suricataSyncSchedulerRegistry', () => ({
  getSuricataSyncScheduler: jest.fn(),
}));

import { getSuricataSyncScheduler } from '@infrastructure/scheduling/suricataSyncSchedulerRegistry';
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
import { InMemoryFileStorage } from '@infrastructure/adapters/in-memory/InMemoryFileStorage';
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

  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  const tickets = new InMemorySuricataTicketRepository();
  const messages = new InMemorySuricataMessageRepository();
  const attachments = new InMemorySuricataAttachmentRepository();
  const verdicts = new InMemorySuricataVerdictRepository();
  const areaRepo = new InMemorySuricataAreaRepository();
  const audits = new InMemorySuricataReplyAuditRepository();
  const fileStorage = new InMemoryFileStorage();
  const featureFlags = new InMemoryFeatureFlagRepository();

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(
    '/api/suricata',
    composeSuricataModule({
      authAdapter: new EchoAuthProvider(userRepo),
      sessionRepo: undefined as unknown as import('@domain/ports/SessionRepository').SessionRepository,
      requirePerm,
      replyToSuricataTicket: new ReplyToSuricataTicket(tickets, audits, new FakeSuricataReply()),
      featureFlags,
      listSuricataTickets: new ListSuricataTickets(tickets, verdicts, areaRepo, userRepo),
      getSuricataTicketDetail: new GetSuricataTicketDetail(tickets, messages, attachments, verdicts, areaRepo, userRepo),
      computeSuricataKpis: new ComputeSuricataKpis(tickets, verdicts),
      setSuricataAssignee: new SetSuricataAssignee(tickets, userRepo),
      areaRepo,
      attachmentRepo: attachments,
      fileStorage,
    }),
  );
  app.use(errorHandler);

  return { app, readerUserId: readerUser.id, managerUserId: managerUser.id };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

describe('POST /api/suricata/sync ("sincronizar ahora" manual)', () => {
  beforeEach(() => {
    (getSuricataSyncScheduler as jest.Mock).mockReset();
  });

  it('requires suricata.manage -- suricata.read alone is rejected', async () => {
    const { app, readerUserId } = await buildApp();
    const res = await asUser(request(app).post('/api/suricata/sync'), readerUserId);
    expect(res.status).toBe(403);
    expect(getSuricataSyncScheduler).not.toHaveBeenCalled();
  });

  it('runs the SAME shared scheduler (runOnce) and returns its summary', async () => {
    const runOnce = jest.fn().mockResolvedValue({ outcome: 'ok', ticketsUpserted: 21 });
    (getSuricataSyncScheduler as jest.Mock).mockReturnValue({ runOnce });

    const { app, managerUserId } = await buildApp();
    const res = await asUser(request(app).post('/api/suricata/sync'), managerUserId);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ outcome: 'ok', ticketsUpserted: 21 });
    expect(runOnce).toHaveBeenCalledTimes(1);
  });

  it('a disabled/unconfigured feature (no scheduler) answers 503, not a 500', async () => {
    (getSuricataSyncScheduler as jest.Mock).mockReturnValue(null);

    const { app, managerUserId } = await buildApp();
    const res = await asUser(request(app).post('/api/suricata/sync'), managerUserId);

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SURICATA_UNAVAILABLE');
  });

  it('the flag being off surfaces as the scheduler`s own {skipped:true}, not an error', async () => {
    const runOnce = jest.fn().mockResolvedValue({ skipped: true });
    (getSuricataSyncScheduler as jest.Mock).mockReturnValue({ runOnce });

    const { app, managerUserId } = await buildApp();
    const res = await asUser(request(app).post('/api/suricata/sync'), managerUserId);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ skipped: true });
  });
});
