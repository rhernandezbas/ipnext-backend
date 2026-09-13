/**
 * suricata-bot-autonomous-actions (Phase C, tasks C.2/C.3, spec
 * `suricata-external-read` EXTREAD-1..5, design D0/D8) — supertest over
 * `composeSuricataExternalModule`'s 3 new GET routes (`/tickets`,
 * `/tickets/:externalId`, `/kpis`), asserting:
 *   - token-only auth (no session/RBAC involved) — EXTREAD-1
 *   - parity with the internal `composeSuricataModule` routes over the SAME
 *     seeded mirror state, same use-case instances (D8: reused AS-IS,
 *     zero changes) — EXTREAD-2/3/4
 *   - unknown externalId -> 404 on detail — EXTREAD-3
 *   - independence from all 4 write flags, which are OFF here and never
 *     checked by these routes at all — EXTREAD-5
 *
 * Repo convention: never mock Prisma, never mock a use case — real use cases
 * + InMemory adapters throughout (molde `externalV1.suricata.routes.test.ts`
 * / `suricata.routes.test.ts`).
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { composeSuricataExternalModule } from '@infrastructure/http/composeSuricataExternalModule';
import { composeSuricataModule } from '@infrastructure/http/composeSuricataModule';
import { createApiKeyMiddleware } from '@infrastructure/http/middleware/apiKeyMiddleware';
import { machineActorMiddleware } from '@infrastructure/http/middleware/machineActorMiddleware';
import { requirePermission } from '@infrastructure/http/middleware/requirePermission';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { API_SURICATA_USER_LOGIN } from '@domain/constants/machineUsers';

import { SubmitSuricataVerdict } from '@application/use-cases/suricata/SubmitSuricataVerdict';
import { ReplyToSuricataTicket } from '@application/use-cases/suricata/ReplyToSuricataTicket';
import { ListSuricataTickets } from '@application/use-cases/suricata/ListSuricataTickets';
import { GetSuricataTicketDetail } from '@application/use-cases/suricata/GetSuricataTicketDetail';
import { ComputeSuricataKpis } from '@application/use-cases/suricata/ComputeSuricataKpis';
import { SetSuricataAssignee } from '@application/use-cases/suricata/SetSuricataAssignee';
import { AddSuricataInternalNote } from '@application/use-cases/suricata/AddSuricataInternalNote';
import { ChangeSuricataTicketStatus } from '@application/use-cases/suricata/ChangeSuricataTicketStatus';
import { CloseSuricataTicket } from '@application/use-cases/suricata/CloseSuricataTicket';

import { InMemorySuricataTicketRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataTicketRepository';
import { InMemorySuricataMessageRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataMessageRepository';
import { InMemorySuricataAttachmentRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataAttachmentRepository';
import { InMemorySuricataVerdictRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataVerdictRepository';
import { InMemorySuricataAreaRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataAreaRepository';
import { InMemorySuricataReplyAuditRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataReplyAuditRepository';
import { InMemorySuricataBotActionAuditRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataBotActionAuditRepository';
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
import type { SessionRepository } from '@domain/ports/SessionRepository';

// `apiKeyMiddleware.ts` imports `config`, which fail-fasts at import time if
// REQUIRED_VARS aren't set (molde `externalV1.suricata.routes.test.ts`). This
// router test passes keys EXPLICITLY, so the mocked value only dodges the
// env crash.
jest.mock('@infrastructure/config', () => ({
  config: {
    externalApi: { apiKey: 'unused-global-key' },
    suricata: { externalApiKey: 'unused-mock-value' },
  },
}));

/** token IS the userId (echoed), molde `suricata.routes.test.ts`. */
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

const DEDICATED_KEY = 'dedicated-suricata-key';
const WRONG_KEY = 'not-the-dedicated-key';

async function buildApps() {
  // ── shared mirror state — SAME instances feed both apps (parity is only
  // meaningful if both routes read the same underlying data). ──────────────
  const tickets = new InMemorySuricataTicketRepository();
  const messages = new InMemorySuricataMessageRepository();
  const attachments = new InMemorySuricataAttachmentRepository();
  const verdicts = new InMemorySuricataVerdictRepository();
  const areaRepo = new InMemorySuricataAreaRepository();
  const replyAudits = new InMemorySuricataReplyAuditRepository();
  const fileStorage = new InMemoryFileStorage();

  // Independent flag stores: the external module's `featureFlags` gates the
  // verdict route ONLY (unrelated to the 3 read routes, EXTREAD-5); the 4
  // bot-write flags below are seeded explicitly OFF and never referenced by
  // the read routes at all.
  const externalFeatureFlags = new InMemoryFeatureFlagRepository();
  const internalFeatureFlags = new InMemoryFeatureFlagRepository();
  externalFeatureFlags.seed('suricata-bot-reply-enabled', false);
  externalFeatureFlags.seed('suricata-bot-close-enabled', false);
  externalFeatureFlags.seed('suricata-bot-status-enabled', false);
  externalFeatureFlags.seed('suricata-bot-note-enabled', false);

  // ── RBAC harness for the INTERNAL app (session + suricata.read) ─────────
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

  const pwHash = await hasher.hash('pw');
  const readerUser = await userRepo.create({
    name: 'reader',
    email: 'reader@x.com',
    login: 'reader',
    passwordHash: pwHash,
    status: 'active',
  });
  await userRoleRepo.assign(readerUser.id, readRole.id);

  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  // ── the SAME 3 use-case instances feed BOTH apps (D8: reused AS-IS) ──────
  const listSuricataTickets = new ListSuricataTickets(tickets, verdicts, areaRepo, userRepo);
  const getSuricataTicketDetail = new GetSuricataTicketDetail(tickets, messages, attachments, verdicts, areaRepo, userRepo);
  const computeSuricataKpis = new ComputeSuricataKpis(tickets, verdicts);
  const submitSuricataVerdict = new SubmitSuricataVerdict(tickets, verdicts);
  const replyToSuricataTicket = new ReplyToSuricataTicket(tickets, replyAudits, new FakeSuricataReply());
  const setSuricataAssignee = new SetSuricataAssignee(tickets, userRepo);
  // suricata-bot-autonomous-actions (Phase D/E/F) — this suite exercises the
  // 3 READ routes only; no-op fake ports are enough for the required deps.
  const botActionAudits = new InMemorySuricataBotActionAuditRepository();
  const addSuricataInternalNote = new AddSuricataInternalNote(tickets, botActionAudits, { addNote: async () => {} });
  const changeSuricataTicketStatus = new ChangeSuricataTicketStatus(tickets, botActionAudits, { changeStatus: async () => {} });
  const closeSuricataTicket = new CloseSuricataTicket(tickets, botActionAudits, { close: async () => {} });

  const internalApp = express();
  internalApp.use(cookieParser());
  internalApp.use(express.json());
  internalApp.use(
    '/api/suricata',
    composeSuricataModule({
      authAdapter: new EchoAuthProvider(userRepo),
      sessionRepo: undefined as unknown as SessionRepository,
      requirePerm,
      replyToSuricataTicket,
      featureFlags: internalFeatureFlags,
      listSuricataTickets,
      getSuricataTicketDetail,
      computeSuricataKpis,
      setSuricataAssignee,
      areaRepo,
      attachmentRepo: attachments,
      fileStorage,
    }),
  );
  internalApp.use(errorHandler);

  // ── EXTERNAL app: dedicated key + machineActorMiddleware, NO session ────
  const machineUserRepo = new InMemoryRbacUserRepository(userRoleRepo, roleRepo);
  const externalApp = express();
  externalApp.use(express.json());
  externalApp.use(
    '/api/external/v1/suricata',
    createApiKeyMiddleware(DEDICATED_KEY),
    machineActorMiddleware(machineUserRepo, API_SURICATA_USER_LOGIN),
    composeSuricataExternalModule({
      submitSuricataVerdict,
      ticketRepo: tickets,
      attachmentRepo: attachments,
      fileStorage,
      featureFlags: externalFeatureFlags,
      listSuricataTickets,
      getSuricataTicketDetail,
      computeSuricataKpis,
      addSuricataInternalNote,
      changeSuricataTicketStatus,
      closeSuricataTicket,
    }),
  );
  externalApp.use(errorHandler);

  return { internalApp, externalApp, tickets, readerUser };
}

async function seedTicket(
  tickets: InMemorySuricataTicketRepository,
  overrides: Partial<Parameters<InMemorySuricataTicketRepository['upsertByExternalId']>[0]> = {},
) {
  return tickets.upsertByExternalId({
    externalId: 'ext-1',
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
    ...overrides,
  });
}

describe('GET /api/external/v1/suricata/tickets (EXTREAD-1/2/5)', () => {
  it('EXTREAD-1 — missing key -> 401, no read logic executed', async () => {
    const { externalApp } = await buildApps();
    const res = await request(externalApp).get('/api/external/v1/suricata/tickets');
    expect(res.status).toBe(401);
  });

  it('EXTREAD-1 — wrong key -> 401', async () => {
    const { externalApp } = await buildApps();
    const res = await request(externalApp).get('/api/external/v1/suricata/tickets').set('X-API-Key', WRONG_KEY);
    expect(res.status).toBe(401);
  });

  it('EXTREAD-2/EXTREAD-5 — same filters/pagination -> identical shape/values as the internal route, all 4 write flags OFF', async () => {
    const { internalApp, externalApp, tickets, readerUser } = await buildApps();
    await seedTicket(tickets, { externalId: 'ext-1', lastMessageAt: '2026-09-01T09:00:00.000Z' });
    await seedTicket(tickets, { externalId: 'ext-2', lastMessageAt: '2026-09-02T09:00:00.000Z' });

    const query = '?status=abierto&page=1&limit=10';

    const internalRes = await request(internalApp)
      .get(`/api/suricata/tickets${query}`)
      .set('Cookie', `auth_token=${readerUser.id}`);
    const externalRes = await request(externalApp)
      .get(`/api/external/v1/suricata/tickets${query}`)
      .set('X-API-Key', DEDICATED_KEY);

    expect(internalRes.status).toBe(200);
    expect(externalRes.status).toBe(200);
    expect(externalRes.body).toEqual(internalRes.body);
    expect(externalRes.body.data).toHaveLength(2);
  });
});

describe('GET /api/external/v1/suricata/tickets/:externalId (EXTREAD-1/3/5)', () => {
  it('EXTREAD-1 — missing key -> 401', async () => {
    const { externalApp } = await buildApps();
    const res = await request(externalApp).get('/api/external/v1/suricata/tickets/ext-1');
    expect(res.status).toBe(401);
  });

  it('EXTREAD-3 — unknown externalId -> 404', async () => {
    const { externalApp } = await buildApps();
    const res = await request(externalApp).get('/api/external/v1/suricata/tickets/ghost').set('X-API-Key', DEDICATED_KEY);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SURICATA_TICKET_NOT_FOUND');
  });

  it('EXTREAD-3/EXTREAD-5 — existing ticket -> identical detail shape/values as the internal route', async () => {
    const { internalApp, externalApp, tickets, readerUser } = await buildApps();
    const ticket = await seedTicket(tickets);

    const internalRes = await request(internalApp)
      .get(`/api/suricata/tickets/${ticket.id}`)
      .set('Cookie', `auth_token=${readerUser.id}`);
    const externalRes = await request(externalApp)
      .get('/api/external/v1/suricata/tickets/ext-1')
      .set('X-API-Key', DEDICATED_KEY);

    expect(internalRes.status).toBe(200);
    expect(externalRes.status).toBe(200);
    expect(externalRes.body).toEqual(internalRes.body);
  });
});

describe('GET /api/external/v1/suricata/kpis (EXTREAD-1/4/5)', () => {
  it('EXTREAD-1 — missing key -> 401', async () => {
    const { externalApp } = await buildApps();
    const res = await request(externalApp).get('/api/external/v1/suricata/kpis');
    expect(res.status).toBe(401);
  });

  it('EXTREAD-4/EXTREAD-5 — identical KPI values as the internal route, all 4 write flags OFF', async () => {
    const { internalApp, externalApp, tickets, readerUser } = await buildApps();
    await seedTicket(tickets, { externalId: 'ext-1' });
    await seedTicket(tickets, { externalId: 'ext-2' });

    const internalRes = await request(internalApp).get('/api/suricata/kpis').set('Cookie', `auth_token=${readerUser.id}`);
    const externalRes = await request(externalApp).get('/api/external/v1/suricata/kpis').set('X-API-Key', DEDICATED_KEY);

    expect(internalRes.status).toBe(200);
    expect(externalRes.status).toBe(200);
    expect(externalRes.body).toEqual(internalRes.body);
    expect(externalRes.body.total).toBe(2);
  });
});
