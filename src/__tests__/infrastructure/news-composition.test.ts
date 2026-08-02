/**
 * Composition-root pin for internal-news (design §6.2, spec NEWS-HTTP-3/4).
 * Two legs, molde uisp-composition.test.ts / actions-composition.test.ts:
 *   (a) source-scan of app.ts — mount exists, receives authAdapter + requirePerm,
 *       and instantiates both Prisma repos.
 *   (b) supertest over the router assembled with in-memory repos — happy path + a real 403.
 * NEWS-HTTP-4 — asserts the diff never touches notifications.routes.ts / the
 * Notification model / the /api/notifications mount.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { InMemoryNewsPostRepository } from '@infrastructure/adapters/in-memory/InMemoryNewsPostRepository';
import { InMemoryNewsCategoryRepository } from '@infrastructure/adapters/in-memory/InMemoryNewsCategoryRepository';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
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

class FakeAuthProvider implements AuthProvider {
  async login() {
    return {
      user: { id: 'a', username: 'u', email: 'e@e.com', role: 'admin' as const },
      cookieValue: 'fake',
      cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 3600, path: '/' },
    };
  }
  logout() {
    return { cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 0, path: '/' } };
  }
  async getSession(token: string): Promise<User> {
    return { id: token, username: token, email: `${token}@test.com`, role: 'admin' };
  }
}

describe('internal-news composition root', () => {
  let appSrc: string;
  let notificationsRoutesSrc: string;

  beforeAll(() => {
    appSrc = readFileSync(join(__dirname, '..', '..', 'infrastructure', 'http', 'app.ts'), 'utf8');
    notificationsRoutesSrc = readFileSync(
      join(__dirname, '..', '..', 'infrastructure', 'http', 'routes', 'notifications.routes.ts'),
      'utf8',
    );
  });

  // ─── (a) source-scan ────────────────────────────────────────────────────────

  it('app.ts imports createNewsRouter', () => {
    expect(appSrc).toMatch(/import.*createNewsRouter.*from.*news\.routes/);
  });

  it("app.ts mounts /api/news", () => {
    expect(appSrc).toMatch(/app\.use\(\s*['"]\/api\/news['"]\s*,\s*createNewsRouter\(/);
  });

  it('the /api/news mount passes authAdapter and requirePerm', () => {
    const idx = appSrc.indexOf("app.use('/api/news'");
    expect(idx).toBeGreaterThan(-1);
    const end = appSrc.indexOf('));', idx);
    expect(end).toBeGreaterThan(idx);
    const window = appSrc.slice(idx, end + '));'.length);
    expect(window).toContain('authAdapter');
    expect(window).toContain('requirePerm');
  });

  it('app.ts instantiates PrismaNewsPostRepository and PrismaNewsCategoryRepository', () => {
    expect(appSrc).toContain('new PrismaNewsPostRepository()');
    expect(appSrc).toContain('new PrismaNewsCategoryRepository()');
  });

  it("rbac.ts declares 'news' in RBAC_MODULES", () => {
    const rbacSrc = readFileSync(join(__dirname, '..', '..', 'domain', 'entities', 'rbac.ts'), 'utf8');
    expect(rbacSrc).toMatch(/'news',/);
  });

  // ─── NEWS-HTTP-4 — notifications intocado (para ESTE change) ───────────────
  //
  // UPDATE (portal-push-notifications, 2026-08-02): esta suite pineaba
  // "notifications.routes.ts nunca gana un requirePerm" para blindar contra
  // que OTRA feature (como internal-news, dueña de esta suite) le agregara un
  // guard de arrastre sin querer — el propio comentario original ya avisaba
  // "that's Change B's job, not this one". `portal-push-notifications` ES esa
  // Change B: agrega `POST /push-service-alert{,/preview}` (alto
  // alcance/riesgo — manda a TODOS los clientes de un nodo) con
  // `auth`+`requirePerm('push','send')` PROPIOS, sin tocar el guard (o la
  // ausencia de guard) de las 4 rutas originales del bell icon interno
  // (`GET /`, `PUT /read-all`, `PUT /:id/read`, `DELETE /:id`). El pin se
  // angosta acá: en vez de "el archivo entero jamás dice requirePerm", ahora
  // verifica PUNTUALMENTE que esas 4 rutas originales siguen sin
  // auth/requirePerm en su cadena de middlewares.

  it('las 4 rutas ORIGINALES del bell icon (GET /, PUT /read-all, PUT /:id/read, DELETE /:id) siguen SIN auth/requirePerm', () => {
    const originalRoutePatterns = [
      /router\.get\(\s*'\/'\s*,\s*async/,
      /router\.put\(\s*'\/read-all'\s*,\s*async/,
      /router\.put\(\s*'\/:id\/read'\s*,\s*async/,
      /router\.delete\(\s*'\/:id'\s*,\s*async/,
    ];
    for (const pattern of originalRoutePatterns) {
      // El handler async va INMEDIATAMENTE después del path — cero middlewares
      // (auth/requirePerm) intercalados, igual que antes de este change.
      expect(notificationsRoutesSrc).toMatch(pattern);
    }
  });

  it('las rutas NUEVAS de push-service-alert SÍ llevan auth + requirePerm (push.send) — guard propio, no de arrastre', () => {
    expect(notificationsRoutesSrc).toMatch(/requirePerm\('push',\s*'send'\)/);
    expect(notificationsRoutesSrc).toContain("'/push-service-alert'");
    expect(notificationsRoutesSrc).toContain("'/push-service-alert/preview'");
  });

  it('app.ts sigue montando /api/notifications con los 4 use cases originales del bell icon en el mismo orden', () => {
    const idx = appSrc.indexOf("app.use('/api/notifications'");
    expect(idx).toBeGreaterThan(-1);
    const end = appSrc.indexOf('));', idx);
    const window = appSrc.slice(idx, end + 3);
    expect(window).toMatch(/listNotifications,\s*markNotificationRead,\s*markAllNotificationsRead,\s*deleteNotification/);
  });

  // ─── (b) behavioral — router assembled with in-memory repos ────────────────

  async function buildApp() {
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

    const readerRole = await roleRepo.create({ code: 'news_reader', label: 'News Reader', isSystem: false });
    const readPerm = await permRepo.seed({ moduleCode: 'news', action: 'read' });
    await rolePermRepo.grant(readerRole.id, readPerm.id);

    const pwHash = await hasher.hash('pw');
    const readUser = await userRepo.create({ name: 'reader', email: 'reader@x.com', login: 'reader', passwordHash: pwHash, status: 'active' });
    await userRoleRepo.assign(readUser.id, readerRole.id);
    const noPermUser = await userRepo.create({ name: 'noperm', email: 'noperm@x.com', login: 'noperm', passwordHash: pwHash, status: 'active' });

    const categoryRepo = new InMemoryNewsCategoryRepository();
    const postRepo = new InMemoryNewsPostRepository(categoryRepo);
    // review fix M3 — keep the fixture at parity with news.routes.test.ts's buildApp.
    categoryRepo.attachPostRepo(postRepo);
    const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    app.use(
      '/api/news',
      createNewsRouter(
        new FakeAuthProvider(),
        undefined,
        requirePerm,
        new ListNewsPosts(postRepo),
        new GetNewsPost(postRepo),
        new CreateNewsPost(postRepo, categoryRepo),
        new UpdateNewsPost(postRepo, categoryRepo),
        new ArchiveNewsPost(postRepo),
        new MarkNewsRead(postRepo),
        new GetNewsUnreadCount(postRepo),
        new ListNewsCategories(categoryRepo),
        new CreateNewsCategory(categoryRepo),
        new UpdateNewsCategory(categoryRepo),
        new DeleteNewsCategory(categoryRepo),
      ),
    );
    app.use(errorHandler);
    return { app, readUserId: readUser.id, noPermUserId: noPermUser.id };
  }

  it('happy path: GET /api/news with news.read → 200', async () => {
    const { app, readUserId } = await buildApp();
    const res = await request(app).get('/api/news').set('Cookie', `auth_token=${readUserId}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], unreadCount: 0 });
  });

  it('real 403: GET /api/news without news.read', async () => {
    const { app, noPermUserId } = await buildApp();
    const res = await request(app).get('/api/news').set('Cookie', `auth_token=${noPermUserId}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });
});
