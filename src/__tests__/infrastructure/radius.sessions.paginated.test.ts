/**
 * radius.sessions.paginated.test.ts
 *
 * TDD: tasks 3.1–3.6 (seam ruta real + use case real + repos in-memory).
 * Cubre: back-compat (array), envelope, validación de params, RBAC, y composition test.
 * NO mockear el use case (lección #28).
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { createRadiusRouter } from '@infrastructure/http/routes/radius.routes';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { requirePermission } from '@infrastructure/http/middleware/requirePermission';

import { InMemoryRadiusSessionRepository } from '@infrastructure/adapters/in-memory/InMemoryRadiusSessionRepository';
import { InMemoryRadiusEventRepository } from '@infrastructure/adapters/in-memory/InMemoryRadiusEventRepository';
import { InMemoryRadiusAuthEventRepository } from '@infrastructure/adapters/in-memory/InMemoryRadiusAuthEventRepository';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';

import { ListRadiusSessions } from '@application/use-cases/ListRadiusSessions';
import { DisconnectSession } from '@application/use-cases/DisconnectSession';
import { ListRadiusEvents } from '@application/use-cases/ListRadiusEvents';
import { ListNe8000PppoeAudit } from '@application/use-cases/ListNe8000PppoeAudit';
import { ListRadiusAuthFailures } from '@application/use-cases/ListRadiusAuthFailures';

import { AuthProvider } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import type { RadiusSessionRepository } from '@domain/ports/RadiusSessionRepository';

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
  readUserId: string;
  manageUserId: string;
  noPermUserId: string;
  pppoeRepo: InMemoryPppoeServiceRepository;
  sessionRepo: InMemoryRadiusSessionRepository;
}

async function buildApp(opts?: { radiusRepo?: RadiusSessionRepository }): Promise<Fixture> {
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

  const readerRole  = await roleRepo.create({ code: 'network_reader2', label: 'Network Reader', isSystem: false });
  const managerRole = await roleRepo.create({ code: 'network_manager2', label: 'Network Manager', isSystem: false });
  const readPerm    = await permRepo.seed({ moduleCode: 'network', action: 'read' });
  const managePerm  = await permRepo.seed({ moduleCode: 'network', action: 'manage' });
  await rolePermRepo.grant(readerRole.id, readPerm.id);
  await rolePermRepo.grant(managerRole.id, readPerm.id);
  await rolePermRepo.grant(managerRole.id, managePerm.id);

  const pwHash = await hasher.hash('pw');
  const mkUser = (login: string) =>
    userRepo.create({ name: login, email: `${login}@x.com`, login, passwordHash: pwHash, status: 'active' });

  const readUser   = await mkUser('reader2');
  const manageUser = await mkUser('manager2');
  const noPermUser = await mkUser('noperm2');
  await userRoleRepo.assign(readUser.id, readerRole.id);
  await userRoleRepo.assign(manageUser.id, managerRole.id);

  const sessionRepo     = new InMemoryRadiusSessionRepository();
  const radiusRepo      = opts?.radiusRepo ?? sessionRepo;
  const pppoeRepo       = new InMemoryPppoeServiceRepository();
  const requirePerm     = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);
  const radiusEventRepo     = new InMemoryRadiusEventRepository();
  const radiusAuthEventRepo = new InMemoryRadiusAuthEventRepository();
  const nasRepo             = new InMemoryNasRepository();

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/radius', createRadiusRouter(
    new EchoAuthProvider(),
    undefined,
    requirePerm,
    new ListRadiusSessions(radiusRepo, pppoeRepo),
    new DisconnectSession(sessionRepo),
    new ListRadiusEvents(radiusEventRepo),
    new ListNe8000PppoeAudit(pppoeRepo, radiusEventRepo, nasRepo),
    new ListRadiusAuthFailures(radiusAuthEventRepo),
  ));
  app.use(errorHandler);

  return { app, readUserId: readUser.id, manageUserId: manageUser.id, noPermUserId: noPermUser.id, pppoeRepo, sessionRepo };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

// ── 3.1 Back-compat: sin params → array ───────────────────────────────────────

describe('radius.routes GET /api/radius/sessions — 3.1 back-compat (sin params → array)', () => {
  it('sin params → 200 Array.isArray(body) === true', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/radius/sessions'), readUserId);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('sin params → 15 sesiones (seed del InMemoryRadiusSessionRepository)', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/radius/sessions'), readUserId);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(15);
  });

  it('sin params → body NO tiene `data` ni `total` (no es un envelope)', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/radius/sessions'), readUserId);

    expect(res.body.data).toBeUndefined();
    expect(res.body.total).toBeUndefined();
  });

  // S1: congela la decisión de "param desconocido" — ninguna de las 5 keys
  // (search|nasId|status|page|limit) → modo array legacy, NO envelope.
  it('S1: param desconocido (?foo=bar, ninguna de las 5 keys) → sigue en modo array legacy', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/radius/sessions?foo=bar'), readUserId);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(15);
  });
});

// ── 3.2 Con params → envelope ─────────────────────────────────────────────────

describe('radius.routes GET /api/radius/sessions — 3.2 envelope con params', () => {
  it('con ?page=1&limit=50 → 200 con shape de envelope', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/radius/sessions?page=1&limit=50'), readUserId);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(typeof res.body.total).toBe('number');
    expect(typeof res.body.page).toBe('number');
    expect(typeof res.body.limit).toBe('number');
    expect(typeof res.body.hasNext).toBe('boolean');
    expect(res.body.stats).toBeDefined();
    expect(typeof res.body.stats.total).toBe('number');
    expect(typeof res.body.stats.active).toBe('number');
    expect(typeof res.body.stats.idle).toBe('number');
  });

  it('data.length <= limit', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/radius/sessions?page=1&limit=10'), readUserId);

    expect(res.body.data.length).toBeLessThanOrEqual(10);
  });

  it('total = 15 (todas las sesiones sin filtros adicionales)', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/radius/sessions?page=1&limit=50'), readUserId);

    expect(res.body.total).toBe(15);
    // S4: sin filtro status, total y stats.total SHALL coincidir (misma unificación
    // documentada en design.md — "total vs stats.total" cuando no hay filtro status).
    expect(res.body.total).toBe(res.body.stats.total);
  });

  it('hasNext === (page * limit < total)', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/radius/sessions?page=1&limit=10'), readUserId);

    // 15 sesiones, limit=10, page=1 → hasNext = true
    expect(res.body.hasNext).toBe(true);

    const res2 = await asUser(request(app).get('/api/radius/sessions?page=2&limit=10'), readUserId);
    // page=2*limit=10=20 >= 15 → hasNext = false
    expect(res2.body.hasNext).toBe(false);
  });

  it('solo search param → también produce envelope', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/radius/sessions?search=user1'), readUserId);

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.stats).toBeDefined();
  });

  it('solo nasId param → también produce envelope', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/radius/sessions?nasId=nas-1'), readUserId);

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
  });
});

// ── 3.3 Validación de params ──────────────────────────────────────────────────

describe('radius.routes GET /api/radius/sessions — 3.3 validación de params', () => {
  it('page=0 → 400 VALIDATION_ERROR', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/radius/sessions?page=0'), readUserId);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('page=abc → 400 VALIDATION_ERROR', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/radius/sessions?page=abc'), readUserId);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('limit=-1 → 400 VALIDATION_ERROR', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/radius/sessions?limit=-1'), readUserId);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('limit=0 → 400 VALIDATION_ERROR', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/radius/sessions?limit=0'), readUserId);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('status=foo → 400 VALIDATION_ERROR', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/radius/sessions?status=foo'), readUserId);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('status=active → 200 (valor válido)', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/radius/sessions?status=active'), readUserId);

    expect(res.status).toBe(200);
  });

  it('status=idle → 200 (valor válido)', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/radius/sessions?status=idle'), readUserId);

    expect(res.status).toBe(200);
  });
});

// ── 3.3b W1: params vacíos ('' = "sin filtro") ────────────────────────────────
//
// Antes: ?search= devolvía todo (ok), ?nasId= devolvía CERO (bug silencioso),
// ?status= daba 400 (bug). Fix: string vacío se normaliza a "sin filtro" para
// los tres — la PRESENCIA de la key sigue activando el envelope (back-compat D1),
// solo el VALOR vacío deja de filtrar/validar.

describe('radius.routes GET /api/radius/sessions — 3.3b W1 params vacíos = sin filtro', () => {
  it('?nasId=&page=1 → envelope con TODAS las sesiones (antes: 0 silencioso)', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/radius/sessions?nasId=&page=1'), readUserId);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(15);
  });

  it('?status= → 200 envelope con TODAS las sesiones (antes: 400)', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/radius/sessions?status='), readUserId);

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.total).toBe(15);
  });

  it('?search= → envelope con TODAS las sesiones (sin filtrar)', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/radius/sessions?search='), readUserId);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(15);
  });
});

// ── 3.3c W2: param repetido (array) → 400, NO 500 ─────────────────────────────
//
// ?search=a&search=b llega a Express como array (['a','b']) — search.toLowerCase()
// dentro del use case revienta con TypeError → antes escalaba a 500 INTERNAL_ERROR.
// Fix: la ruta valida el TIPO antes de invocar el use case → 400 VALIDATION_ERROR.

describe('radius.routes GET /api/radius/sessions — 3.3c W2 param repetido → 400 no 500', () => {
  it('?search=a&search=b (array) → 400 VALIDATION_ERROR', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/radius/sessions?search=a&search=b'), readUserId);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('?nasId=a&nasId=b (array) → 400 VALIDATION_ERROR', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/radius/sessions?nasId=a&nasId=b'), readUserId);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

// ── 3.3d W3: seam de ruta faltantes (cap de limit + page fuera de rango) ──────

describe('radius.routes GET /api/radius/sessions — 3.3d W3 seam de ruta: cap de limit y page fuera de rango', () => {
  it('?limit=999 → envelope con limit=200 (cap aplicado en el seam completo)', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/radius/sessions?page=1&limit=999'), readUserId);

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(200);
  });

  it('?page=999 → data vacía, total correcto, hasNext false (seam completo)', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/radius/sessions?page=999'), readUserId);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.total).toBe(15);
    expect(res.body.hasNext).toBe(false);
  });
});

// ── 3.4 RBAC (se preserva el gate actual) ────────────────────────────────────

describe('radius.routes GET /api/radius/sessions — 3.4 RBAC', () => {
  it('sin auth → 401 (sin params)', async () => {
    const { app } = await buildApp();
    expect((await request(app).get('/api/radius/sessions')).status).toBe(401);
  });

  it('sin auth → 401 (con params)', async () => {
    const { app } = await buildApp();
    expect((await request(app).get('/api/radius/sessions?page=1')).status).toBe(401);
  });

  it('sin network.read → 403 (sin params)', async () => {
    const { app, noPermUserId } = await buildApp();
    expect((await asUser(request(app).get('/api/radius/sessions'), noPermUserId)).status).toBe(403);
  });

  it('sin network.read → 403 (con params)', async () => {
    const { app, noPermUserId } = await buildApp();
    expect((await asUser(request(app).get('/api/radius/sessions?page=1'), noPermUserId)).status).toBe(403);
  });
});

// ── 3.6 Composition test: ruta real → use case real → in-memory ──────────────

describe('radius.routes GET /api/radius/sessions — 3.6 composition (anti feature-muerta)', () => {
  it('search matchea por username en el seam completo (ruta+uc+in-memory)', async () => {
    const { app, readUserId } = await buildApp();
    // El in-memory genera usernames "user1@ipnext.com.ar" ... "user15@ipnext.com.ar"
    const res = await asUser(request(app).get('/api/radius/sessions?search=user1'), readUserId);

    expect(res.status).toBe(200);
    // user1, user10, user11, user12, user13, user14, user15 contienen "user1" = 7
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    expect(res.body.data.every((s: any) => s.username.toLowerCase().includes('user1'))).toBe(true);
  });

  it('nasId filtra en el seam completo', async () => {
    const { app, readUserId } = await buildApp();
    // El in-memory distribuye: i%3==0→nas-1, i%3==1→nas-2, i%3==2→nas-3
    const res = await asUser(request(app).get('/api/radius/sessions?nasId=nas-1'), readUserId);

    expect(res.status).toBe(200);
    expect(res.body.data.every((s: any) => s.nasId === 'nas-1')).toBe(true);
  });

  it('status=idle filtra en el seam completo (in-memory produce idle para i>12)', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/radius/sessions?status=idle'), readUserId);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.data.every((s: any) => s.status === 'idle')).toBe(true);
  });

  it('stats.total = total sin filtro status (patrón countsByReason)', async () => {
    const { app, readUserId } = await buildApp();
    // Con status=active, el total del active = 12, pero stats.total debe ser 15 (todos)
    const res = await asUser(request(app).get('/api/radius/sessions?status=active'), readUserId);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(12);       // solo las active
    expect(res.body.stats.total).toBe(15); // todas (ignora status)
    expect(res.body.stats.idle).toBe(3);   // los idle siguen contados en stats
  });

  it('paginación server-side: page 1 y page 2 sin solapamiento (orden estable)', async () => {
    const { app, readUserId } = await buildApp();
    const p1 = await asUser(request(app).get('/api/radius/sessions?page=1&limit=10'), readUserId);
    const p2 = await asUser(request(app).get('/api/radius/sessions?page=2&limit=10'), readUserId);

    expect(p1.body.total).toBe(15);
    expect(p1.body.data).toHaveLength(10);
    expect(p2.body.data).toHaveLength(5);

    const ids1 = new Set(p1.body.data.map((s: any) => s.id));
    const ids2 = p2.body.data.map((s: any) => s.id);
    // Sin solapamiento
    expect(ids2.every((id: string) => !ids1.has(id))).toBe(true);
  });

  it('error async del use case → 500 INTERNAL_ERROR via errorHandler (catch → next(err), Express 4 sin express-async-errors)', async () => {
    // Repo que revienta: simula orchestrator caído. Sin next(err) la request queda
    // COLGADA (unhandled rejection) y este test se va a timeout — eso es lo que caza.
    const failingRepo: RadiusSessionRepository = {
      async listSessions(): Promise<never> { throw new Error('orchestrator down'); },
      async disconnectSession(): Promise<{ success: boolean }> { return { success: false }; },
    };
    const { app, readUserId } = await buildApp({ radiusRepo: failingRepo });

    // Modo envelope (con params)
    const resEnvelope = await asUser(request(app).get('/api/radius/sessions?page=1&limit=10'), readUserId);
    expect(resEnvelope.status).toBe(500);
    expect(resEnvelope.body.code).toBe('INTERNAL_ERROR');

    // Modo array legacy (sin params) — mismo contrato de error
    const resArray = await asUser(request(app).get('/api/radius/sessions'), readUserId);
    expect(resArray.status).toBe(500);
    expect(resArray.body.code).toBe('INTERNAL_ERROR');
  });

  it('customerName enriquecido por pppoeRepo llega al FE (seam completo)', async () => {
    const { app, readUserId, pppoeRepo } = await buildApp();
    await pppoeRepo.upsertByUsername({
      username: 'user1@ipnext.com.ar',
      password: 'p',
      nasId: 'nas-1',
      contractId: 'c-seam',
    });
    pppoeRepo.setContractClient('c-seam', 'cli-seam', 'Juan Seam');

    const res = await asUser(request(app).get('/api/radius/sessions?search=user1@ipnext'), readUserId);

    expect(res.status).toBe(200);
    const s1 = res.body.data.find((s: any) => s.username === 'user1@ipnext.com.ar');
    expect(s1).toBeDefined();
    expect(s1.customerName).toBe('Juan Seam');
  });
});
