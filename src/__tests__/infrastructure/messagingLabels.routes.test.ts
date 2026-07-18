/**
 * conversation-labels (Ola 5) — integration tests de messagingLabels.routes.ts.
 * Seam COMPLETO: supertest → router → use-cases → InMemory repo → errorHandler.
 * Molde EXACTO de ticketAreas.routes.test.ts (EchoAuthProvider + RBAC in-memory).
 *
 * Read guard:   messaging.read
 * Manage guard: messaging.manage
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { InMemoryConversationLabelRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationLabelRepository';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';

import { requirePermission } from '@infrastructure/http/middleware/requirePermission';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { createMessagingLabelsRouter } from '@infrastructure/http/routes/messagingLabels.routes';

import { ListLabels } from '@application/use-cases/messaging/ListLabels';
import { CreateLabel } from '@application/use-cases/messaging/CreateLabel';
import { UpdateLabel } from '@application/use-cases/messaging/UpdateLabel';
import { DeleteLabel } from '@application/use-cases/messaging/DeleteLabel';

import { AuthProvider } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';

class EchoAuthProvider implements AuthProvider {
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
    return { id: token, username: 'test', email: 'test@test.com', role: 'admin' };
  }
}

interface Fixture {
  app: express.Express;
  labelRepo: InMemoryConversationLabelRepository;
  manageUserId: string;
  readOnlyUserId: string;
  noPermUserId: string;
}

async function buildApp(): Promise<Fixture> {
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

  const managerRole = await roleRepo.create({ code: 'msg_manager', label: 'Msg Manager', isSystem: false });
  const readerRole = await roleRepo.create({ code: 'msg_reader', label: 'Msg Reader', isSystem: false });

  const managePerm = await permRepo.seed({ moduleCode: 'messaging', action: 'manage' });
  const readPerm = await permRepo.seed({ moduleCode: 'messaging', action: 'read' });

  await rolePermRepo.grant(managerRole.id, managePerm.id);
  await rolePermRepo.grant(managerRole.id, readPerm.id);
  await rolePermRepo.grant(readerRole.id, readPerm.id);

  const pwHash = await hasher.hash('pw');
  const mkUser = (login: string) =>
    userRepo.create({ name: login, email: `${login}@x.com`, login, passwordHash: pwHash, status: 'active' });

  const manageUser = await mkUser('manager');
  await userRoleRepo.assign(manageUser.id, managerRole.id);

  const readUser = await mkUser('reader');
  await userRoleRepo.assign(readUser.id, readerRole.id);

  const noPermUser = await mkUser('noperm');

  const labelRepo = new InMemoryConversationLabelRepository();

  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(
    '/api/messaging/labels',
    createMessagingLabelsRouter(
      new EchoAuthProvider(),
      requirePerm,
      new ListLabels(labelRepo),
      new CreateLabel(labelRepo),
      new UpdateLabel(labelRepo),
      new DeleteLabel(labelRepo),
    ),
  );
  app.use(errorHandler);

  return { app, labelRepo, manageUserId: manageUser.id, readOnlyUserId: readUser.id, noPermUserId: noPermUser.id };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

describe('GET /api/messaging/labels', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await buildApp(); });

  it('con messaging.read → 200 array', async () => {
    await fx.labelRepo.create({ name: 'Urgente', color: '#ef4444' });
    const res = await asUser(request(fx.app).get('/api/messaging/labels'), fx.readOnlyUserId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
  });

  it('sin token → 401', async () => {
    const res = await request(fx.app).get('/api/messaging/labels');
    expect(res.status).toBe(401);
  });

  it('sin messaging.read → 403', async () => {
    const res = await asUser(request(fx.app).get('/api/messaging/labels'), fx.noPermUserId);
    expect(res.status).toBe(403);
  });
});

describe('POST /api/messaging/labels', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await buildApp(); });

  it('con messaging.manage → 201 created', async () => {
    const res = await asUser(
      request(fx.app).post('/api/messaging/labels').send({ name: 'Urgente', color: '#ef4444' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Urgente');
    expect(res.body.color).toBe('#ef4444');
    expect(res.body.id).toBeTruthy();
  });

  it('rechaza un color no-hex → 400', async () => {
    const res = await asUser(
      request(fx.app).post('/api/messaging/labels').send({ name: 'Urgente', color: 'red' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('rechaza color ausente → 400', async () => {
    const res = await asUser(
      request(fx.app).post('/api/messaging/labels').send({ name: 'Urgente' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('409 en nombre duplicado', async () => {
    await asUser(request(fx.app).post('/api/messaging/labels').send({ name: 'Urgente', color: '#ef4444' }), fx.manageUserId);
    const res = await asUser(
      request(fx.app).post('/api/messaging/labels').send({ name: 'Urgente', color: '#000000' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONVERSATION_LABEL_NAME_CONFLICT');
  });

  it('sin messaging.manage → 403', async () => {
    const res = await asUser(
      request(fx.app).post('/api/messaging/labels').send({ name: 'Urgente', color: '#ef4444' }),
      fx.readOnlyUserId,
    );
    expect(res.status).toBe(403);
  });

  it('trimea el name y whitespace-only → 400', async () => {
    const ok = await asUser(
      request(fx.app).post('/api/messaging/labels').send({ name: '  Urgente  ', color: '#ef4444' }),
      fx.manageUserId,
    );
    expect(ok.status).toBe(201);
    expect(ok.body.name).toBe('Urgente');

    const bad = await asUser(
      request(fx.app).post('/api/messaging/labels').send({ name: '   ', color: '#ef4444' }),
      fx.manageUserId,
    );
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('PUT /api/messaging/labels/:id', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await buildApp(); });

  it('con messaging.manage → 200 updated', async () => {
    const label = await fx.labelRepo.create({ name: 'Urgente', color: '#ef4444' });
    const res = await asUser(
      request(fx.app).put(`/api/messaging/labels/${label.id}`).send({ name: 'Muy urgente', color: '#dc2626' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Muy urgente');
    expect(res.body.color).toBe('#dc2626');
  });

  it('409 en conflicto de nombre', async () => {
    await fx.labelRepo.create({ name: 'Ventas', color: '#22c55e' });
    const other = await fx.labelRepo.create({ name: 'Urgente', color: '#ef4444' });
    const res = await asUser(
      request(fx.app).put(`/api/messaging/labels/${other.id}`).send({ name: 'Ventas' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONVERSATION_LABEL_NAME_CONFLICT');
  });

  it('404 en label inexistente', async () => {
    const res = await asUser(
      request(fx.app).put('/api/messaging/labels/nonexistent').send({ name: 'X' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CONVERSATION_LABEL_NOT_FOUND');
  });

  it('sin messaging.manage → 403', async () => {
    const label = await fx.labelRepo.create({ name: 'Urgente', color: '#ef4444' });
    const res = await asUser(
      request(fx.app).put(`/api/messaging/labels/${label.id}`).send({ name: 'X' }),
      fx.readOnlyUserId,
    );
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/messaging/labels/:id', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await buildApp(); });

  it('con messaging.manage → 204 (sin guard de uso, cascadea)', async () => {
    const label = await fx.labelRepo.create({ name: 'Urgente', color: '#ef4444' });
    const res = await asUser(request(fx.app).delete(`/api/messaging/labels/${label.id}`), fx.manageUserId);
    expect(res.status).toBe(204);
  });

  it('404 en label inexistente', async () => {
    const res = await asUser(request(fx.app).delete('/api/messaging/labels/nonexistent'), fx.manageUserId);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CONVERSATION_LABEL_NOT_FOUND');
  });

  it('sin messaging.manage → 403', async () => {
    const label = await fx.labelRepo.create({ name: 'Urgente', color: '#ef4444' });
    const res = await asUser(request(fx.app).delete(`/api/messaging/labels/${label.id}`), fx.readOnlyUserId);
    expect(res.status).toBe(403);
  });
});
