/**
 * pppoe.inspect-devices.routes.test.ts — supertest seam
 *
 * Cubre:
 *   - GET /contracts/:id/inspect-pppoe-devices → 200 con DTO (happy path)
 *   - 200 con warnings (airos no alcanzable, best-effort)
 *   - 401 sin auth
 *   - 403 sin permiso inventory.write
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { createContractInventoryRouter } from '@infrastructure/http/routes/contractInventory.routes';
import { createInspectPppoeDevicesRouter } from '@infrastructure/http/routes/inspectPppoeDevices.routes';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { requirePermission } from '@infrastructure/http/middleware/requirePermission';

import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryAirOsGateway } from '@infrastructure/adapters/in-memory/InMemoryAirOsGateway';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';

import { InspectPppoeDevices } from '@application/use-cases/InspectPppoeDevices';
import { AirOsUnreachableError } from '@domain/errors/airos';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import type { OrchestratorSession } from '@domain/ports/RadiusOrchestratorGateway';

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

const CONTRACT_ID = 'contract-x';
const PPP_USER = 'cliente01';
const ANTENNA_IP = '100.64.10.173';

function makeSession(): OrchestratorSession {
  return {
    sessionId: 's1', username: PPP_USER, nasIp: '10.0.0.1',
    framedIp: ANTENNA_IP, startedAt: new Date().toISOString(),
    bytesIn: 0, bytesOut: 0, callerId: 'AA:BB:CC:11:22:33',
  };
}

async function buildApp(opts: {
  airosThrows?: Error;
  hasPppoe?: boolean;
}) {
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

  const writerRole = await roleRepo.create({ code: 'inv_writer', label: 'Inv Writer', isSystem: false });
  const writePerm = await permRepo.seed({ moduleCode: 'inventory', action: 'write' });
  await rolePermRepo.grant(writerRole.id, writePerm.id);

  const pwHash = await hasher.hash('pw');
  const writeUser = await userRepo.create({ name: 'writer', email: 'w@x.com', login: 'writer', passwordHash: pwHash, status: 'active' });
  const noPermUser = await userRepo.create({ name: 'noperm', email: 'n@x.com', login: 'noperm', passwordHash: pwHash, status: 'active' });
  await userRoleRepo.assign(writeUser.id, writerRole.id);

  const pppoeRepo = new InMemoryPppoeServiceRepository();
  if (opts.hasPppoe !== false) {
    await pppoeRepo.upsertByUsername({
      username: PPP_USER, password: 'pass', nasId: 'nas-1',
      contractId: CONTRACT_ID, status: 'enabled', remoteAddress: ANTENNA_IP,
    });
  }

  const orchestrator = new InMemoryRadiusOrchestratorGateway({
    seed: [{ username: PPP_USER, sessions: [makeSession()] }],
  });

  const airos = opts.airosThrows
    ? new InMemoryAirOsGateway({ throws: opts.airosThrows })
    : new InMemoryAirOsGateway({
        result: { model: 'LiteBeam 5AC Gen2', ownMac: '78:8A:20:96:6A:AE', lanMacs: ['c0:c9:e3:34:33:75'] },
      });

  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);
  const auth = new EchoAuthProvider();

  const uc = new InspectPppoeDevices(pppoeRepo, orchestrator, airos);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api', createInspectPppoeDevicesRouter(uc, auth, undefined, requirePerm));
  app.use(errorHandler);

  return { app, writeUserId: writeUser.id, noPermUserId: noPermUser.id };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

describe('GET /contracts/:id/inspect-pppoe-devices', () => {
  it('200 happy path — retorna antenna + router + brand', async () => {
    const { app, writeUserId } = await buildApp({});
    const res = await asUser(
      request(app).get(`/api/contracts/${CONTRACT_ID}/inspect-pppoe-devices`),
      writeUserId,
    );
    expect(res.status).toBe(200);
    expect(res.body.antenna.model).toBe('LiteBeam 5AC Gen2');
    expect(res.body.antenna.mac).toBe('78:8A:20:96:6A:AE');
    expect(res.body.router?.mac).toBe('c0:c9:e3:34:33:75');
    expect(res.body.router?.brand).toBe('TP-Link');
    expect(res.body.warnings).toEqual([]);
  });

  it('200 best-effort — airos unreachable retorna warnings en lugar de error', async () => {
    const { app, writeUserId } = await buildApp({
      airosThrows: new AirOsUnreachableError(ANTENNA_IP),
    });
    const res = await asUser(
      request(app).get(`/api/contracts/${CONTRACT_ID}/inspect-pppoe-devices`),
      writeUserId,
    );
    expect(res.status).toBe(200);
    expect(res.body.warnings.length).toBeGreaterThan(0);
    expect(res.body.router).toBeNull();
  });

  it('401 sin auth', async () => {
    const { app } = await buildApp({});
    const res = await request(app).get(`/api/contracts/${CONTRACT_ID}/inspect-pppoe-devices`);
    expect(res.status).toBe(401);
  });

  it('403 sin permiso inventory.write', async () => {
    const { app, noPermUserId } = await buildApp({});
    const res = await asUser(
      request(app).get(`/api/contracts/${CONTRACT_ID}/inspect-pppoe-devices`),
      noPermUserId,
    );
    expect(res.status).toBe(403);
  });
});
