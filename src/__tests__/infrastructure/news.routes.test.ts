/**
 * Integration tests for news.routes.ts — full seam: supertest → router →
 * use-cases → InMemory repos. Fixture calco EXACTO de ticketAreas.routes.test.ts
 * (EchoAuthProvider + in-memory RBAC), con 3 usuarios: manage / read-only / sin permiso.
 *
 * Read guard:  news.read
 * Write guard: news.manage
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { InMemoryNewsPostRepository } from '@infrastructure/adapters/in-memory/InMemoryNewsPostRepository';
import { InMemoryNewsCategoryRepository } from '@infrastructure/adapters/in-memory/InMemoryNewsCategoryRepository';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';

import { requirePermission } from '@infrastructure/http/middleware/requirePermission';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { createNewsRouter } from '@infrastructure/http/routes/news.routes';

import { ListNewsPosts } from '@application/use-cases/ListNewsPosts';
import { GetNewsPost } from '@application/use-cases/GetNewsPost';
import { CreateNewsPost } from '@application/use-cases/CreateNewsPost';
import { UpdateNewsPost } from '@application/use-cases/UpdateNewsPost';
import { ArchiveNewsPost } from '@application/use-cases/ArchiveNewsPost';
import { MarkNewsRead } from '@application/use-cases/MarkNewsRead';
import { GetNewsUnreadCount } from '@application/use-cases/GetNewsUnreadCount';
import { ListNewsCategories } from '@application/use-cases/ListNewsCategories';
import { CreateNewsCategory } from '@application/use-cases/CreateNewsCategory';
import { UpdateNewsCategory } from '@application/use-cases/UpdateNewsCategory';
import { DeleteNewsCategory } from '@application/use-cases/DeleteNewsCategory';

import { AuthProvider } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';

/**
 * token IS the userId (echoed straight through the cookie, molde
 * ticketAreas.routes.test.ts). Resolves the real login as `username` — the
 * POST / route stamps `authorName` from `req.user.username`, and the news
 * tests assert on that value, so this needs a real lookup (not a canned
 * username like ticketAreas.routes.test.ts's fixture).
 */
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

interface Fixture {
  app: express.Express;
  categoryRepo: InMemoryNewsCategoryRepository;
  postRepo: InMemoryNewsPostRepository;
  manageUserId: string;
  readOnlyUserId: string;
  noPermUserId: string;
}

async function buildApp(): Promise<Fixture> {
  const roleRepo     = new InMemoryRbacRoleRepository();
  const userRoleRepo = new InMemoryRbacUserRoleRepository();
  const permRepo     = new InMemoryRbacPermissionRepository();
  const rolePermRepo = new InMemoryRbacRolePermissionRepository();
  const hasher       = new InMemoryPasswordHasher();
  const userRepo     = new InMemoryRbacUserRepository(userRoleRepo, roleRepo);

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

  const managerRole = await roleRepo.create({ code: 'news_manager', label: 'News Manager', isSystem: false });
  const readerRole  = await roleRepo.create({ code: 'news_reader',  label: 'News Reader',  isSystem: false });

  const managePerm = await permRepo.seed({ moduleCode: 'news', action: 'manage' });
  const readPerm   = await permRepo.seed({ moduleCode: 'news', action: 'read' });

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

  const categoryRepo = new InMemoryNewsCategoryRepository();
  const postRepo = new InMemoryNewsPostRepository(categoryRepo);
  // review fix M3: countPosts (DeleteNewsCategory's in-use guard) counts REAL posts
  // against the paired post repo instead of a hand-set seam.
  categoryRepo.attachPostRepo(postRepo);

  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  const listNewsPosts      = new ListNewsPosts(postRepo);
  const getNewsPost        = new GetNewsPost(postRepo);
  const createNewsPost     = new CreateNewsPost(postRepo, categoryRepo);
  const updateNewsPost     = new UpdateNewsPost(postRepo, categoryRepo);
  const archiveNewsPost    = new ArchiveNewsPost(postRepo);
  const markNewsRead       = new MarkNewsRead(postRepo);
  const getNewsUnreadCount = new GetNewsUnreadCount(postRepo);
  const listNewsCategories = new ListNewsCategories(categoryRepo);
  const createNewsCategory = new CreateNewsCategory(categoryRepo);
  const updateNewsCategory = new UpdateNewsCategory(categoryRepo);
  const deleteNewsCategory = new DeleteNewsCategory(categoryRepo);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(
    '/api/news',
    createNewsRouter(
      new EchoAuthProvider(userRepo),
      requirePerm,
      listNewsPosts,
      getNewsPost,
      createNewsPost,
      updateNewsPost,
      archiveNewsPost,
      markNewsRead,
      getNewsUnreadCount,
      listNewsCategories,
      createNewsCategory,
      updateNewsCategory,
      deleteNewsCategory,
    ),
  );
  app.use(errorHandler);

  return { app, categoryRepo, postRepo, manageUserId: manageUser.id, readOnlyUserId: readUser.id, noPermUserId: noPermUser.id };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

// ─── 401 sin cookie ──────────────────────────────────────────────────────────

describe('GET /api/news — 401 sin cookie', () => {
  it('responde 401', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/news');
    expect(res.status).toBe(401);
  });
});

// ─── 403 lectura sin news.read ────────────────────────────────────────────────

describe('403 sin news.read', () => {
  it('GET / → 403', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).get('/api/news'), fx.noPermUserId);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });

  it('GET /unread-count → 403', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).get('/api/news/unread-count'), fx.noPermUserId);
    expect(res.status).toBe(403);
  });

  it('GET /categories → 403', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).get('/api/news/categories'), fx.noPermUserId);
    expect(res.status).toBe(403);
  });
});

// ─── 403 mutación con SOLO news.read ───────────────────────────────────────────

describe('403 con solo news.read (sin news.manage) en TODAS las mutaciones', () => {
  it('POST / → 403', async () => {
    const fx = await buildApp();
    const res = await asUser(
      request(fx.app).post('/api/news').send({ title: 'T', body: 'B', categoryId: 'x' }),
      fx.readOnlyUserId,
    );
    expect(res.status).toBe(403);
  });

  it('PUT /:id → 403', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).put('/api/news/some-id').send({ title: 'T' }), fx.readOnlyUserId);
    expect(res.status).toBe(403);
  });

  it('PUT /:id/archive → 403', async () => {
    const fx = await buildApp();
    const res = await asUser(
      request(fx.app).put('/api/news/some-id/archive').send({ archived: true }),
      fx.readOnlyUserId,
    );
    expect(res.status).toBe(403);
  });

  it('POST /categories → 403', async () => {
    const fx = await buildApp();
    const res = await asUser(
      request(fx.app).post('/api/news/categories').send({ name: 'X', color: '#111111' }),
      fx.readOnlyUserId,
    );
    expect(res.status).toBe(403);
  });

  it('PUT /categories/:id → 403', async () => {
    const fx = await buildApp();
    const res = await asUser(
      request(fx.app).put('/api/news/categories/some-id').send({ name: 'X' }),
      fx.readOnlyUserId,
    );
    expect(res.status).toBe(403);
  });

  it('DELETE /categories/:id → 403', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).delete('/api/news/categories/some-id'), fx.readOnlyUserId);
    expect(res.status).toBe(403);
  });

  it('GET /?archived=true → 403', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).get('/api/news?archived=true'), fx.readOnlyUserId);
    expect(res.status).toBe(403);
  });
});

// ─── Lector marca leída (news.read alcanza) ────────────────────────────────────

describe('POST /:id/read — con SOLO news.read', () => {
  it('204, idempotente en la segunda llamada', async () => {
    const fx = await buildApp();
    const category = await fx.categoryRepo.create({ name: 'General', color: '#64748b' });
    const post = await fx.postRepo.create({ title: 'T', body: 'B', categoryId: category.id, authorId: 'a', authorName: 'A' });

    const res1 = await asUser(request(fx.app).post(`/api/news/${post.id}/read`), fx.readOnlyUserId);
    expect(res1.status).toBe(204);
    const res2 = await asUser(request(fx.app).post(`/api/news/${post.id}/read`), fx.readOnlyUserId);
    expect(res2.status).toBe(204);
  });

  it('404 si el post no existe', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).post('/api/news/missing/read'), fx.readOnlyUserId);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NEWS_POST_NOT_FOUND');
  });
});

// ─── GET / — contratos, orden, filtros ─────────────────────────────────────────

describe('GET /api/news', () => {
  it('200 con { items, unreadCount }', async () => {
    const fx = await buildApp();
    const category = await fx.categoryRepo.create({ name: 'General', color: '#64748b' });
    await fx.postRepo.create({ title: 'T1', body: 'B', categoryId: category.id, authorId: 'a', authorName: 'A' });

    const res = await asUser(request(fx.app).get('/api/news'), fx.readOnlyUserId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.unreadCount).toBe(1);
  });

  it('?archived=true con news.manage → 200 solo archivados', async () => {
    const fx = await buildApp();
    const category = await fx.categoryRepo.create({ name: 'General', color: '#64748b' });
    const toArchive = await fx.postRepo.create({ title: 'A archivar', body: 'B', categoryId: category.id, authorId: 'a', authorName: 'A' });
    await fx.postRepo.setArchived(toArchive.id, true);
    await fx.postRepo.create({ title: 'Activo', body: 'B', categoryId: category.id, authorId: 'a', authorName: 'A' });

    const res = await asUser(request(fx.app).get('/api/news?archived=true'), fx.manageUserId);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].title).toBe('A archivar');
  });
});

// ─── GET /unread-count — barato ────────────────────────────────────────────────

describe('GET /api/news/unread-count', () => {
  it('devuelve { count } solo activas sin leer', async () => {
    const fx = await buildApp();
    const category = await fx.categoryRepo.create({ name: 'General', color: '#64748b' });
    await fx.postRepo.create({ title: 'T1', body: 'B', categoryId: category.id, authorId: 'a', authorName: 'A' });
    const archived = await fx.postRepo.create({ title: 'T2', body: 'B', categoryId: category.id, authorId: 'a', authorName: 'A' });
    await fx.postRepo.setArchived(archived.id, true);

    const res = await asUser(request(fx.app).get('/api/news/unread-count'), fx.readOnlyUserId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 1 });
  });
});

// ─── Rutas estáticas no tragadas por /:id ──────────────────────────────────────

describe('rutas estáticas no tragadas por /:id', () => {
  it('/unread-count y /categories responden sus handlers propios', async () => {
    const fx = await buildApp();
    const r1 = await asUser(request(fx.app).get('/api/news/unread-count'), fx.readOnlyUserId);
    const r2 = await asUser(request(fx.app).get('/api/news/categories'), fx.readOnlyUserId);
    expect(r1.status).toBe(200);
    expect(r1.body).toEqual({ count: 0 });
    expect(r2.status).toBe(200);
    expect(Array.isArray(r2.body)).toBe(true);
  });
});

// ─── POST / — create ────────────────────────────────────────────────────────────

describe('POST /api/news', () => {
  it('con news.manage → 201, estampa autor de sesión', async () => {
    const fx = await buildApp();
    const category = await fx.categoryRepo.create({ name: 'General', color: '#64748b' });
    const res = await asUser(
      request(fx.app).post('/api/news').send({ title: 'Novedad', body: 'Detalle', categoryId: category.id }),
      fx.manageUserId,
    );
    expect(res.status).toBe(201);
    expect(res.body.title).toBe('Novedad');
    expect(res.body.authorId).toBe(fx.manageUserId);
    expect(res.body.authorName).toBe('manager');
  });

  it('400 VALIDATION_ERROR — title vacío tras trim', async () => {
    const fx = await buildApp();
    const category = await fx.categoryRepo.create({ name: 'General', color: '#64748b' });
    const res = await asUser(
      request(fx.app).post('/api/news').send({ title: '   ', body: 'x', categoryId: category.id }),
      fx.manageUserId,
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('422 categoría inexistente', async () => {
    const fx = await buildApp();
    const res = await asUser(
      request(fx.app).post('/api/news').send({ title: 'T', body: 'B', categoryId: 'missing-cat' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('NEWS_CATEGORY_NOT_FOUND');
  });
});

// ─── GET /:id — detalle ──────────────────────────────────────────────────────────

describe('GET /api/news/:id', () => {
  it('200 con detalle, NO auto-marca leído', async () => {
    const fx = await buildApp();
    const category = await fx.categoryRepo.create({ name: 'General', color: '#64748b' });
    const post = await fx.postRepo.create({ title: 'T', body: 'B', categoryId: category.id, authorId: 'a', authorName: 'A' });

    const res = await asUser(request(fx.app).get(`/api/news/${post.id}`), fx.readOnlyUserId);
    expect(res.status).toBe(200);
    expect(res.body.read).toBe(false);

    const countRes = await asUser(request(fx.app).get('/api/news/unread-count'), fx.readOnlyUserId);
    expect(countRes.body.count).toBe(1);
  });

  it('404 en id inexistente', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).get('/api/news/missing'), fx.readOnlyUserId);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NEWS_POST_NOT_FOUND');
  });
});

// ─── PUT /:id — update ────────────────────────────────────────────────────────────

describe('PUT /api/news/:id', () => {
  it('con news.manage → 200 actualizado', async () => {
    const fx = await buildApp();
    const category = await fx.categoryRepo.create({ name: 'General', color: '#64748b' });
    const post = await fx.postRepo.create({ title: 'Old', body: 'B', categoryId: category.id, authorId: 'a', authorName: 'A' });

    const res = await asUser(request(fx.app).put(`/api/news/${post.id}`).send({ title: 'New' }), fx.manageUserId);
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('New');
  });

  it('404 en id inexistente', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).put('/api/news/missing').send({ title: 'X' }), fx.manageUserId);
    expect(res.status).toBe(404);
  });

  it('422 categoría inexistente', async () => {
    const fx = await buildApp();
    const category = await fx.categoryRepo.create({ name: 'General', color: '#64748b' });
    const post = await fx.postRepo.create({ title: 'T', body: 'B', categoryId: category.id, authorId: 'a', authorName: 'A' });
    const res = await asUser(
      request(fx.app).put(`/api/news/${post.id}`).send({ categoryId: 'missing-cat' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(422);
  });
});

// ─── PUT /:id/archive ───────────────────────────────────────────────────────────

describe('PUT /api/news/:id/archive', () => {
  it('con news.manage → 200 archivado/desarchivado', async () => {
    const fx = await buildApp();
    const category = await fx.categoryRepo.create({ name: 'General', color: '#64748b' });
    const post = await fx.postRepo.create({ title: 'T', body: 'B', categoryId: category.id, authorId: 'a', authorName: 'A' });

    const res = await asUser(
      request(fx.app).put(`/api/news/${post.id}/archive`).send({ archived: true }),
      fx.manageUserId,
    );
    expect(res.status).toBe(200);
    expect(res.body.archivedAt).toBeTruthy();
  });

  it('404 en id inexistente', async () => {
    const fx = await buildApp();
    const res = await asUser(
      request(fx.app).put('/api/news/missing/archive').send({ archived: true }),
      fx.manageUserId,
    );
    expect(res.status).toBe(404);
  });
});

// ─── Categorías: CRUD 409s ───────────────────────────────────────────────────────

describe('POST /api/news/categories', () => {
  it('con news.manage → 201', async () => {
    const fx = await buildApp();
    const res = await asUser(
      request(fx.app).post('/api/news/categories').send({ name: 'Comercial', color: '#10b981' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Comercial');
  });

  it('409 en nombre duplicado', async () => {
    const fx = await buildApp();
    await fx.categoryRepo.create({ name: 'Comercial', color: '#10b981' });
    const res = await asUser(
      request(fx.app).post('/api/news/categories').send({ name: 'Comercial', color: '#000000' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NEWS_CATEGORY_NAME_CONFLICT');
  });

  it('400 color inválido', async () => {
    const fx = await buildApp();
    const res = await asUser(
      request(fx.app).post('/api/news/categories').send({ name: 'X', color: 'red' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(400);
  });

  // review fix L6: CreateNewsCategorySchema.name gana .max(60).
  it('400 nombre supera el máximo (60)', async () => {
    const fx = await buildApp();
    const res = await asUser(
      request(fx.app).post('/api/news/categories').send({ name: 'x'.repeat(61), color: '#111111' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('DELETE /api/news/categories/:id', () => {
  it('409 in-use cuando tiene posts', async () => {
    const fx = await buildApp();
    const category = await fx.categoryRepo.create({ name: 'General', color: '#64748b' });
    // review fix M3: el post real es lo que bloquea el delete — ya no hay seam postCounts.
    await fx.postRepo.create({ title: 'T', body: 'B', categoryId: category.id, authorId: 'a', authorName: 'A' });

    const res = await asUser(request(fx.app).delete(`/api/news/categories/${category.id}`), fx.manageUserId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NEWS_CATEGORY_IN_USE');
  });

  it('204 cuando la categoría está vacía', async () => {
    const fx = await buildApp();
    const category = await fx.categoryRepo.create({ name: 'Vacía', color: '#000000' });
    const res = await asUser(request(fx.app).delete(`/api/news/categories/${category.id}`), fx.manageUserId);
    expect(res.status).toBe(204);
  });

  it('404 en id inexistente', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).delete('/api/news/categories/missing'), fx.manageUserId);
    expect(res.status).toBe(404);
  });
});
