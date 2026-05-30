/**
 * auditEmitDedupe.test.ts — REQ-AUD-EMIT-1 (SDD #4 Phase 3).
 *
 * When SetRolePermissions runs, the route emits a faithful before/after
 * SET_ROLE_PERMISSIONS event, and the generic mutation middleware does NOT
 * create a second event for the same request (dedupe → exactly one event).
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';

import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryAuditEventRepository } from '@infrastructure/adapters/in-memory/InMemoryAuditEventRepository';

import { ListPermissionIdsForRole } from '@application/use-cases/rbac/ListPermissionIdsForRole';
import { SetRolePermissions } from '@application/use-cases/rbac/SetRolePermissions';
import { createRolePermissionsRouter } from '@infrastructure/http/routes/rolePermissions.routes';
import { auditMutationsMiddleware } from '@infrastructure/http/middleware/auditMutationsMiddleware';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';

const flush = () => new Promise(resolve => setImmediate(resolve));
const pass = (_req: Request, _res: Response, next: NextFunction) => next();

async function buildApp() {
  const roleRepo = new InMemoryRbacRoleRepository();
  const rolePermRepo = new InMemoryRbacRolePermissionRepository();
  const permRepo = new InMemoryRbacPermissionRepository();
  const auditRepo = new InMemoryAuditEventRepository();

  const role = await roleRepo.create({ code: 'tecnico', label: 'Técnico', isSystem: true });
  const permA = await permRepo.seed({ moduleCode: 'scheduling', action: 'read' });
  const permB = await permRepo.seed({ moduleCode: 'scheduling', action: 'write' });
  await rolePermRepo.replaceForRole(role.id, [permA.id]); // before = [permA]

  const listPermIds = new ListPermissionIdsForRole(roleRepo, rolePermRepo);
  const setRolePerms = new SetRolePermissions(roleRepo, rolePermRepo, permRepo);

  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: unknown }).user = { id: 'admin-1', username: 'admin', email: 'a@x' };
    next();
  });
  app.use(auditMutationsMiddleware(auditRepo)); // generic MW
  app.use('/api/admin/rbac/roles', createRolePermissionsRouter(listPermIds, setRolePerms, pass, pass, auditRepo));
  app.use(errorHandler);

  return { app, auditRepo, roleId: role.id, permA, permB };
}

describe('SET_ROLE_PERMISSIONS audit emit + dedupe', () => {
  it('records exactly one faithful event with before/after', async () => {
    const { app, auditRepo, roleId, permA, permB } = await buildApp();

    const res = await request(app)
      .put(`/api/admin/rbac/roles/${roleId}/permissions`)
      .send({ permissionIds: [permA.id, permB.id] });
    expect(res.status).toBe(200);
    await flush();

    const page = await auditRepo.list({ page: 1, pageSize: 10 });
    expect(page.total).toBe(1); // dedupe: generic MW did NOT add a second event
    const ev = page.items[0];
    expect(ev).toMatchObject({ action: 'SET_ROLE_PERMISSIONS', entityType: 'RbacRole', entityId: roleId });
    expect((ev.beforeJson as { permissionIds: string[] }).permissionIds).toEqual([permA.id]);
    expect((ev.afterJson as { permissionIds: string[] }).permissionIds).toEqual(
      expect.arrayContaining([permA.id, permB.id]),
    );
  });
});
