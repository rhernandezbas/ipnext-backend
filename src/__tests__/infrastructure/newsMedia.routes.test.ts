/**
 * N2 — integration tests for the news media sub-router (attachments + broadcast).
 * Auth: EchoAuthProvider (cookie token = userId) + in-memory RBAC.
 * Gates: news:read (serve binary), news:manage (upload / link / delete / broadcast).
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { InMemoryFileStorage } from '@infrastructure/adapters/in-memory/InMemoryFileStorage';
import { InMemoryNewsPostAttachmentRepository } from '@infrastructure/adapters/in-memory/InMemoryNewsPostAttachmentRepository';
import { InMemoryNewsPostRepository } from '@infrastructure/adapters/in-memory/InMemoryNewsPostRepository';
import { InMemoryNewsCategoryRepository } from '@infrastructure/adapters/in-memory/InMemoryNewsCategoryRepository';
import { InMemoryNocBroadcastConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryNocBroadcastConfigRepository';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';

import { requirePermission } from '@infrastructure/http/middleware/requirePermission';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { createNewsMediaRouter } from '@infrastructure/http/routes/newsMedia.routes';

import { AttachFilesToNews } from '@application/use-cases/AttachFilesToNews';
import { AttachLinkToNews } from '@application/use-cases/AttachLinkToNews';
import { GetNewsAttachmentFile } from '@application/use-cases/GetNewsAttachmentFile';
import { DeleteNewsAttachment } from '@application/use-cases/DeleteNewsAttachment';
import { BroadcastNewsToNoc } from '@application/use-cases/BroadcastNewsToNoc';
import { BroadcastToNoc } from '@application/use-cases/nocBroadcast/BroadcastToNoc';

import { AuthProvider } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';
import { NocBroadcastGateway } from '@domain/ports/NocBroadcastGateway';
import { NocBroadcastNotConfiguredError, EvolutionApiError } from '@domain/errors/nocBroadcast';
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

class FakeGateway implements NocBroadcastGateway {
  sent: string[] = [];
  error: Error | null = null;
  async sendText(text: string): Promise<void> {
    if (this.error) throw this.error;
    this.sent.push(text);
  }
}

async function buildRbac() {
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

  const managerRole = await roleRepo.create({ code: 'news_manager', label: 'M', isSystem: false });
  const readerRole = await roleRepo.create({ code: 'news_reader', label: 'R', isSystem: false });
  const managePerm = await permRepo.seed({ moduleCode: 'news', action: 'manage' });
  const readPerm = await permRepo.seed({ moduleCode: 'news', action: 'read' });
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

  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);
  return { requirePerm, manageUserId: manageUser.id, readUserId: readUser.id, noPermUserId: noPermUser.id };
}

async function buildApp(opts: { appPublicUrl?: string } = {}) {
  const { requirePerm, manageUserId, readUserId, noPermUserId } = await buildRbac();

  const categoryRepo = new InMemoryNewsCategoryRepository();
  const postRepo = new InMemoryNewsPostRepository(categoryRepo);
  const cat = await categoryRepo.create({ name: 'Red', color: '#6366f1' });
  const post = await postRepo.create({ title: 'Corte Zona Norte', body: 'B', categoryId: cat.id, authorId: 'a', authorName: 'A' });

  const attachmentRepo = new InMemoryNewsPostAttachmentRepository();
  const storage = new InMemoryFileStorage();

  const config = new InMemoryNocBroadcastConfigRepository();
  await config.update({ appPublicUrl: opts.appPublicUrl ?? 'http://190.7.234.37:7778' });
  const gateway = new FakeGateway();

  const router = createNewsMediaRouter(
    {
      attachFilesToNews: new AttachFilesToNews(attachmentRepo, storage, postRepo),
      attachLinkToNews: new AttachLinkToNews(attachmentRepo, postRepo),
      getNewsAttachmentFile: new GetNewsAttachmentFile(attachmentRepo, storage),
      deleteNewsAttachment: new DeleteNewsAttachment(attachmentRepo, storage),
      broadcastNewsToNoc: new BroadcastNewsToNoc(postRepo, new BroadcastToNoc(config, gateway)),
    },
    {
      authProvider: new EchoAuthProvider(),
      requireRead: requirePerm('news', 'read'),
      requireManage: requirePerm('news', 'manage'),
    },
  );

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/news', router);
  app.use(errorHandler);

  return { app, gateway, postId: post.id, manageUserId, readUserId, noPermUserId };
}

const asUser = (req: request.Test, userId: string): request.Test => req.set('Cookie', `auth_token=${userId}`);

describe('POST /api/news/:id/attachments (files)', () => {
  it('sin news:manage → 403', async () => {
    const { app, postId, readUserId } = await buildApp();
    const res = await asUser(
      request(app)
        .post(`/api/news/${postId}/attachments`)
        .attach('files', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { filename: 'a.jpg', contentType: 'image/jpeg' }),
      readUserId,
    );
    expect(res.status).toBe(403);
  });

  it('con news:manage + multipart → 201 DTO[] (fileUrl, sin storageKey)', async () => {
    const { app, postId, manageUserId } = await buildApp();
    const res = await asUser(
      request(app)
        .post(`/api/news/${postId}/attachments`)
        .attach('files', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { filename: 'a.jpg', contentType: 'image/jpeg' }),
      manageUserId,
    );
    expect(res.status).toBe(201);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].kind).toBe('image');
    expect(res.body[0].fileUrl).toBe(`/api/news/attachments/${res.body[0].id}/file`);
    expect(res.body[0].storageKey).toBeUndefined();
  });

  it('mimetype no soportado → 415', async () => {
    const { app, postId, manageUserId } = await buildApp();
    const res = await asUser(
      request(app)
        .post(`/api/news/${postId}/attachments`)
        .attach('files', Buffer.from('x'), { filename: 'a.exe', contentType: 'application/x-msdownload' }),
      manageUserId,
    );
    expect(res.status).toBe(415);
    expect(res.body.code).toBe('UNSUPPORTED_NEWS_ATTACHMENT_TYPE');
  });

  it('post inexistente → 404', async () => {
    const { app, manageUserId } = await buildApp();
    const res = await asUser(
      request(app)
        .post('/api/news/ghost/attachments')
        .attach('files', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { filename: 'a.jpg', contentType: 'image/jpeg' }),
      manageUserId,
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NEWS_POST_NOT_FOUND');
  });

  it('archivo > 10 MiB → 413', async () => {
    const { app, postId, manageUserId } = await buildApp();
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 0x41);
    const res = await asUser(
      request(app)
        .post(`/api/news/${postId}/attachments`)
        .attach('files', big, { filename: 'big.jpg', contentType: 'image/jpeg' }),
      manageUserId,
    );
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('FILE_TOO_LARGE');
  });
});

describe('POST /api/news/:id/attachments (link JSON)', () => {
  it('con news:manage + {kind:link,url} → 201 DTO link', async () => {
    const { app, postId, manageUserId } = await buildApp();
    const res = await asUser(
      request(app).post(`/api/news/${postId}/attachments`).send({ kind: 'link', url: 'https://status.example.com', filename: 'Panel' }),
      manageUserId,
    );
    expect(res.status).toBe(201);
    expect(res.body.kind).toBe('link');
    expect(res.body.url).toBe('https://status.example.com');
    expect(res.body.fileUrl).toBeNull();
  });

  it('link con url inválida → 422', async () => {
    const { app, postId, manageUserId } = await buildApp();
    const res = await asUser(
      request(app).post(`/api/news/${postId}/attachments`).send({ kind: 'link', url: 'ftp://nope' }),
      manageUserId,
    );
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_LINK_ATTACHMENT');
  });

  it('ni archivos ni link → 400', async () => {
    const { app, postId, manageUserId } = await buildApp();
    const res = await asUser(request(app).post(`/api/news/${postId}/attachments`).send({ foo: 'bar' }), manageUserId);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/news/attachments/:id/file', () => {
  async function createImage(app: express.Express, postId: string, userId: string) {
    const res = await asUser(
      request(app)
        .post(`/api/news/${postId}/attachments`)
        .attach('files', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { filename: 'foto.jpg', contentType: 'image/jpeg' }),
      userId,
    );
    return res.body[0];
  }

  it('con news:read → 200 binario inline', async () => {
    const { app, postId, manageUserId, readUserId } = await buildApp();
    const dto = await createImage(app, postId, manageUserId);
    const res = await asUser(request(app).get(`/api/news/attachments/${dto.id}/file`), readUserId);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
    expect(res.headers['content-disposition']).toContain('inline');
  });

  it('sin news:read → 403', async () => {
    const { app, postId, manageUserId, noPermUserId } = await buildApp();
    const dto = await createImage(app, postId, manageUserId);
    const res = await asUser(request(app).get(`/api/news/attachments/${dto.id}/file`), noPermUserId);
    expect(res.status).toBe(403);
  });

  it('inexistente → 404', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/news/attachments/ghost/file'), readUserId);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NEWS_ATTACHMENT_NOT_FOUND');
  });
});

describe('DELETE /api/news/attachments/:id', () => {
  it('con news:manage → 204', async () => {
    const { app, postId, manageUserId } = await buildApp();
    const created = await asUser(
      request(app)
        .post(`/api/news/${postId}/attachments`)
        .attach('files', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { filename: 'foto.jpg', contentType: 'image/jpeg' }),
      manageUserId,
    );
    const res = await asUser(request(app).delete(`/api/news/attachments/${created.body[0].id}`), manageUserId);
    expect(res.status).toBe(204);
  });

  it('sin news:manage → 403', async () => {
    const { app, postId, manageUserId, readUserId } = await buildApp();
    const created = await asUser(
      request(app)
        .post(`/api/news/${postId}/attachments`)
        .attach('files', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { filename: 'foto.jpg', contentType: 'image/jpeg' }),
      manageUserId,
    );
    const res = await asUser(request(app).delete(`/api/news/attachments/${created.body[0].id}`), readUserId);
    expect(res.status).toBe(403);
  });
});

describe('POST /api/news/:id/broadcast', () => {
  it('con news:manage → 200 {sent,link} y llama al gateway con 📢 + link', async () => {
    const { app, postId, manageUserId, gateway } = await buildApp();
    const res = await asUser(request(app).post(`/api/news/${postId}/broadcast`), manageUserId);
    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(true);
    expect(res.body.link).toBe(`http://190.7.234.37:7778/admin/news?post=${postId}`);
    expect(gateway.sent[0]).toContain('📢 Corte Zona Norte');
    expect(gateway.sent[0]).toContain(`/admin/news?post=${postId}`);
  });

  it('sin news:manage → 403', async () => {
    const { app, postId, readUserId } = await buildApp();
    const res = await asUser(request(app).post(`/api/news/${postId}/broadcast`), readUserId);
    expect(res.status).toBe(403);
  });

  it('post inexistente → 404', async () => {
    const { app, manageUserId } = await buildApp();
    const res = await asUser(request(app).post('/api/news/ghost/broadcast'), manageUserId);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NEWS_POST_NOT_FOUND');
  });

  it('gateway no configurado → 503 NOC_BROADCAST_NOT_CONFIGURED', async () => {
    const { app, postId, manageUserId, gateway } = await buildApp();
    gateway.error = new NocBroadcastNotConfiguredError();
    const res = await asUser(request(app).post(`/api/news/${postId}/broadcast`), manageUserId);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('NOC_BROADCAST_NOT_CONFIGURED');
  });

  it('error de Evolution → 502 EVOLUTION_API_ERROR', async () => {
    const { app, postId, manageUserId, gateway } = await buildApp();
    gateway.error = new EvolutionApiError('boom');
    const res = await asUser(request(app).post(`/api/news/${postId}/broadcast`), manageUserId);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('EVOLUTION_API_ERROR');
  });
});
