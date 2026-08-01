/**
 * #117 — SEAM completo: operador en el historial de servicios del contrato.
 *
 * Ruta real → use case real → repos in-memory → GET service-history.
 * Verifica que el actorName que entra al POST/PATCH/DELETE sale en el historial.
 *
 * Escenarios:
 *   T4: POST /services con user "jperez" → GET service-history → activated con actorName:"jperez"
 *   T5: PATCH (active→inactive) con user "jperez" → deactivated con actorName:"jperez"
 *   T5b: PATCH (inactive→active) con user "jperez" → reactivated con actorName:"jperez"
 *   T5c: DELETE → deactivated con actorName:"jperez"
 *   T7: 401 sin auth, 403 sin clients.read
 *   T-degradation: evento sembrado con actorName:'' y actorId → actorName:'' (InMemory no resuelve JOIN)
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryContractRepository } from '@infrastructure/adapters/in-memory/InMemoryContractRepository';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';

import { requirePermission } from '@infrastructure/http/middleware/requirePermission';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { createContractServicesRouter } from '@infrastructure/http/routes/contractServices.routes';

import { UpdateContractName } from '@application/use-cases/UpdateContractName';
import { AddContractService } from '@application/use-cases/AddContractService';
import { UpdateContractService } from '@application/use-cases/UpdateContractService';
import { RemoveContractService } from '@application/use-cases/RemoveContractService';
import { ListContractServiceHistory } from '@application/use-cases/ListContractServiceHistory';

import { AuthProvider } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';

/**
 * Auth provider que resuelve el userId como id Y como username (simula JWT real).
 * El userId se usa como token cookie, y username es el login del operador.
 * Para simular "jperez": cookie = userId_jperez, getSession → { id, username: 'jperez' }
 */
class OperatorAuthProvider implements AuthProvider {
  // map: userId → User
  private users: Map<string, User> = new Map();

  register(user: User): void {
    this.users.set(user.id, user);
  }

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
    const user = this.users.get(token);
    if (!user) throw new Error('Unknown token');
    return user;
  }
}

interface Fixture {
  app: express.Express;
  catalogRepo: InMemoryServiceCatalogRepository;
  csRepo: InMemoryContractServiceRepository;
  cseRepo: InMemoryContractServiceEventRepository;
  contractRepo: InMemoryContractRepository;
  contracts: Set<string>;
  /** userId that maps to username "jperez" and has clients.write + clients.read */
  jperezUserId: string;
  /** userId with clients.read only */
  readerUserId: string;
  /** userId with no permissions */
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

  const writeRole  = await roleRepo.create({ code: 'svc_writer', label: 'Svc Writer', isSystem: false });
  const readerRole = await roleRepo.create({ code: 'svc_reader', label: 'Svc Reader', isSystem: false });
  const noPermRole = await roleRepo.create({ code: 'noperm',     label: 'No Perm',    isSystem: false });

  const writePerm = await permRepo.seed({ moduleCode: 'clients', action: 'write' });
  const readPerm  = await permRepo.seed({ moduleCode: 'clients', action: 'read' });

  await rolePermRepo.grant(writeRole.id, writePerm.id);
  await rolePermRepo.grant(writeRole.id, readPerm.id);   // writer also has read
  await rolePermRepo.grant(readerRole.id, readPerm.id);

  const pwHash = await hasher.hash('pw');
  const mkUser = (login: string) =>
    userRepo.create({ name: login, email: `${login}@x.com`, login, passwordHash: pwHash, status: 'active' });

  const jperezUser  = await mkUser('jperez');
  const readerUser  = await mkUser('reader');
  const noPermUser  = await mkUser('noperm');

  await userRoleRepo.assign(jperezUser.id, writeRole.id);
  await userRoleRepo.assign(readerUser.id, readerRole.id);
  await userRoleRepo.assign(noPermUser.id, noPermRole.id);

  // Auth provider que mapea userId → User con username correcto
  const authProvider = new OperatorAuthProvider();
  authProvider.register({ id: jperezUser.id, username: 'jperez', email: 'jperez@x.com', role: 'admin' });
  authProvider.register({ id: readerUser.id, username: 'reader', email: 'reader@x.com', role: 'admin' });
  authProvider.register({ id: noPermUser.id, username: 'noperm', email: 'noperm@x.com', role: 'admin' });

  const catalogRepo  = new InMemoryServiceCatalogRepository();
  const csRepo       = new InMemoryContractServiceRepository();
  const cseRepo      = new InMemoryContractServiceEventRepository();
  const contractRepo = new InMemoryContractRepository();
  const contracts    = new Set<string>();
  const contractLookup = { findById: async (id: string) => (contracts.has(id) ? { id } : null) };

  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api', createContractServicesRouter(
    authProvider,
    undefined,
    requirePerm,
    new UpdateContractName(contractRepo),
    new AddContractService(csRepo, catalogRepo, contractLookup, cseRepo),
    new UpdateContractService(csRepo, cseRepo),
    new RemoveContractService(csRepo, cseRepo),
    new ListContractServiceHistory(csRepo, cseRepo),
  ));
  app.use(errorHandler);

  return {
    app,
    catalogRepo,
    csRepo,
    cseRepo,
    contractRepo,
    contracts,
    jperezUserId: jperezUser.id,
    readerUserId: readerUser.id,
    noPermUserId: noPermUser.id,
  };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

async function seedCatalog(fx: Fixture, name: string, active = true) {
  const cat = await fx.catalogRepo.create({ name, label: name, active, sortOrder: 0 });
  fx.csRepo.catalog[cat.id] = { name: cat.name, label: cat.label };
  return cat;
}

describe('#117 — SEAM operador: POST/PATCH/DELETE → GET service-history', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await buildApp(); });

  // T4 — POST con jperez → GET muestra actorName:"jperez" en activated
  it('T4: POST /services como jperez → service-history[].events[0].actorName === "jperez"', async () => {
    fx.contracts.add('C');
    const cat = await seedCatalog(fx, 'INTERNET');

    const postRes = await asUser(
      request(fx.app).post('/api/contracts/C/services').send({ serviceCatalogId: cat.id }),
      fx.jperezUserId,
    );
    expect(postRes.status).toBe(201);

    const histRes = await asUser(
      request(fx.app).get('/api/contracts/C/service-history'),
      fx.jperezUserId,
    );
    expect(histRes.status).toBe(200);
    expect(histRes.body).toHaveLength(1);

    const item = histRes.body[0];
    expect(item.events).toHaveLength(1);
    expect(item.events[0].eventType).toBe('activated');
    expect(item.events[0].actorName).toBe('jperez');
  });

  // T4b — tvPassword ausente en todo el body
  it('T4b: actorName presente, tvPassword siempre ausente de la respuesta', async () => {
    fx.contracts.add('C');
    const cat = await seedCatalog(fx, 'INTERNET');

    await asUser(
      request(fx.app).post('/api/contracts/C/services').send({ serviceCatalogId: cat.id }),
      fx.jperezUserId,
    );

    const histRes = await asUser(
      request(fx.app).get('/api/contracts/C/service-history'),
      fx.jperezUserId,
    );
    expect(histRes.status).toBe(200);
    const json = JSON.stringify(histRes.body);
    expect(json).not.toContain('tvPassword');
  });

  // T5 — PATCH active→inactive muestra deactivated con actorName:"jperez"
  it('T5: PATCH status:inactive como jperez → service-history muestra deactivated con actorName:"jperez"', async () => {
    fx.contracts.add('C');
    const cat = await seedCatalog(fx, 'INTERNET');

    const postRes = await asUser(
      request(fx.app).post('/api/contracts/C/services').send({ serviceCatalogId: cat.id }),
      fx.jperezUserId,
    );
    expect(postRes.status).toBe(201);
    const svcId = postRes.body.id;

    const patchRes = await asUser(
      request(fx.app).patch(`/api/contracts/C/services/${svcId}`).send({ status: 'inactive' }),
      fx.jperezUserId,
    );
    expect(patchRes.status).toBe(200);

    const histRes = await asUser(
      request(fx.app).get('/api/contracts/C/service-history'),
      fx.jperezUserId,
    );
    expect(histRes.status).toBe(200);

    const item = histRes.body[0];
    // events: [activated, deactivated] ordered ASC
    expect(item.events).toHaveLength(2);
    expect(item.events[0].eventType).toBe('activated');
    expect(item.events[0].actorName).toBe('jperez');
    expect(item.events[1].eventType).toBe('deactivated');
    expect(item.events[1].actorName).toBe('jperez');
  });

  // T5b — PATCH inactive→active muestra reactivated con actorName:"jperez"
  it('T5b: PATCH status:active (reactivación) como jperez → service-history muestra reactivated con actorName:"jperez"', async () => {
    fx.contracts.add('C');
    const cat = await seedCatalog(fx, 'INTERNET');

    const postRes = await asUser(
      request(fx.app).post('/api/contracts/C/services').send({ serviceCatalogId: cat.id }),
      fx.jperezUserId,
    );
    const svcId = postRes.body.id;

    // deactivate
    await asUser(
      request(fx.app).patch(`/api/contracts/C/services/${svcId}`).send({ status: 'inactive' }),
      fx.jperezUserId,
    );
    // reactivate
    const reactivateRes = await asUser(
      request(fx.app).patch(`/api/contracts/C/services/${svcId}`).send({ status: 'active' }),
      fx.jperezUserId,
    );
    expect(reactivateRes.status).toBe(200);

    const histRes = await asUser(
      request(fx.app).get('/api/contracts/C/service-history'),
      fx.jperezUserId,
    );
    expect(histRes.status).toBe(200);

    const item = histRes.body[0];
    // events: [activated, deactivated, reactivated] ordered ASC
    expect(item.events).toHaveLength(3);
    expect(item.events[2].eventType).toBe('reactivated');
    expect(item.events[2].actorName).toBe('jperez');
  });

  // T5c — DELETE registra evento deactivated con actorName:"jperez"
  // Nota: el InMemory borra la fila físicamente en delete(), por lo que GET /service-history
  // devuelve [] post-DELETE. El evento quedó registrado en el cseRepo — lo verificamos ahí.
  // El adapter Prisma mantiene la fila (soft delete en evento), por lo que en producción
  // el historial sí muestra el evento. Este test verifica el registro del evento (threading del actor).
  it('T5c: DELETE como jperez → cseRepo registra evento deactivated con actorName:"jperez"', async () => {
    fx.contracts.add('C');
    const cat = await seedCatalog(fx, 'INTERNET');

    const postRes = await asUser(
      request(fx.app).post('/api/contracts/C/services').send({ serviceCatalogId: cat.id }),
      fx.jperezUserId,
    );
    expect(postRes.status).toBe(201);
    const svcId = postRes.body.id;

    const deleteRes = await asUser(
      request(fx.app).delete(`/api/contracts/C/services/${svcId}`),
      fx.jperezUserId,
    );
    expect(deleteRes.status).toBe(204);

    // El servicio fue eliminado físicamente en el InMemory; historial vacío
    const histRes = await asUser(
      request(fx.app).get('/api/contracts/C/service-history'),
      fx.jperezUserId,
    );
    expect(histRes.status).toBe(200);
    expect(histRes.body).toHaveLength(0);

    // El evento deactivated sí fue registrado con el operador correcto
    const allEvents = fx.cseRepo.all();
    const deactivated = allEvents.find(e => e.eventType === 'deactivated');
    expect(deactivated).toBeDefined();
    expect(deactivated!.actorName).toBe('jperez');
  });

  // T7 — 401 sin auth
  it('T7a: GET service-history sin auth → 401', async () => {
    const res = await request(fx.app).get('/api/contracts/C/service-history');
    expect(res.status).toBe(401);
  });

  // T7 — 403 sin clients.read
  it('T7b: GET service-history sin clients.read → 403', async () => {
    const res = await asUser(
      request(fx.app).get('/api/contracts/C/service-history'),
      fx.noPermUserId,
    );
    expect(res.status).toBe(403);
  });

  // T-degradation: evento sembrado con actorName:'' + actorId → InMemory devuelve '' (sin JOIN)
  it('T-degradation: evento sembrado con actorName:"" + actorId → InMemory devuelve "" (sin JOIN)', async () => {
    fx.contracts.add('C');
    const cat = await seedCatalog(fx, 'INTERNET');
    const svc = await fx.csRepo.add({ contractId: 'C', serviceCatalogId: cat.id });

    // Sembrar evento viejo (sin snapshot pero con actorId) directamente en el repo
    await fx.cseRepo.record({
      contractId:       'C',
      serviceCatalogId: cat.id,
      eventType:        'activated',
      actorId:          fx.jperezUserId,  // tiene actorId pero actorName vacío
      actorName:        '',               // snapshot vacío (evento viejo)
    });

    const histRes = await asUser(
      request(fx.app).get('/api/contracts/C/service-history'),
      fx.readerUserId,
    );
    expect(histRes.status).toBe(200);

    const item = histRes.body[0];
    expect(item.id).toBe(svc.id);
    expect(item.events).toHaveLength(1);
    // InMemory NO resuelve actorId → login. El JOIN es exclusivo del adapter Prisma.
    // Este comportamiento está documentado: el InMemory devuelve el snapshot sembrado.
    expect(item.events[0].actorName).toBe('');
  });
});
