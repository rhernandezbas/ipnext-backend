/**
 * wifi-self-service (F0) — route-level coverage de `/api/wifi` (admin,
 * `wifi.read`/`wifi.manage`), molde `promos.routes.test.ts` (EchoAuthProvider +
 * RBAC in-memory + cookie `auth_token=<userId>`).
 *
 * Cubre los casos TDD 9 (admin SÍ trae ip/mac — contraparte del portal), 10
 * (enable-tr069: sin vlan -> 400 con pista; con vlan -> llama la cadena EN
 * ORDEN, mgmt primero) y 11 (sin SMARTOLT_API_KEY -> 503 SMARTOLT_NOT_CONFIGURED).
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';

import { requirePermission } from '@infrastructure/http/middleware/requirePermission';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { createWifiRouter } from '@infrastructure/http/routes/wifi.routes';

import { GetAdminOnuWifiStatus } from '@application/use-cases/wifi/GetAdminOnuWifiStatus';
import { SetAdminWifiBand } from '@application/use-cases/wifi/SetAdminWifiBand';
import { EnableOnuTr069 } from '@application/use-cases/wifi/EnableOnuTr069';

import { AuthProvider } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import type { WifiManagementPort, OnuWifiStatus, SetWifiBandInput, RouterHost } from '@domain/ports/WifiManagementPort';
import type { OltProvisioningGateway } from '@domain/ports/OltProvisioningGateway';
import { OltProvisioningError } from '@domain/errors/smartolt';

/** token IS the userId (echoed, molde promos.routes.test.ts). */
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

const ONLINE_STATUS: OnuWifiStatus = {
  found: true,
  onuType: 'HG8145V5',
  online: true,
  tr069Enabled: true,
  bands: [{ band: '2.4', port: 'wifi_0/1', ssid: 'Casa', enabled: true }],
};

class FakeAdminWifi implements WifiManagementPort {
  statusBySn = new Map<string, OnuWifiStatus>();
  hostsBySn = new Map<string, RouterHost[]>();
  notConfigured = false;
  setCalls: Array<{ sn: string; input: SetWifiBandInput }> = [];

  private guard(): void {
    if (this.notConfigured) throw new OltProvisioningError('not_configured', 'SmartOLT no configurado');
  }

  async getOnuWifiStatus(sn: string): Promise<OnuWifiStatus> {
    this.guard();
    return this.statusBySn.get(sn) ?? { found: false, onuType: null, online: false, tr069Enabled: false, bands: [] };
  }

  async setWifiBand(sn: string, input: SetWifiBandInput): Promise<void> {
    this.guard();
    this.setCalls.push({ sn, input });
  }

  async getRouterHosts(sn: string): Promise<RouterHost[]> {
    this.guard();
    return this.hostsBySn.get(sn) ?? [];
  }
}

class FakeProvisioning implements Pick<OltProvisioningGateway, 'setMgmtIp' | 'enableTr069'> {
  calls: Array<{ method: 'setMgmtIp' | 'enableTr069'; sn: string; arg: number | string }> = [];
  notConfigured = false;

  private guard(): void {
    if (this.notConfigured) throw new OltProvisioningError('not_configured', 'SmartOLT no configurado');
  }

  async setMgmtIp(sn: string, vlan: number): Promise<void> {
    this.guard();
    this.calls.push({ method: 'setMgmtIp', sn, arg: vlan });
  }

  async enableTr069(sn: string, profile: string): Promise<void> {
    this.guard();
    this.calls.push({ method: 'enableTr069', sn, arg: profile });
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

  const managerRole = await roleRepo.create({ code: 'wifi_manager', label: 'WiFi Manager', isSystem: false });
  const readerRole = await roleRepo.create({ code: 'wifi_reader', label: 'WiFi Reader', isSystem: false });

  const managePerm = await permRepo.seed({ moduleCode: 'wifi', action: 'manage' });
  const readPerm = await permRepo.seed({ moduleCode: 'wifi', action: 'read' });

  await rolePermRepo.grant(managerRole.id, managePerm.id);
  await rolePermRepo.grant(managerRole.id, readPerm.id);
  await rolePermRepo.grant(readerRole.id, readPerm.id);

  const pwHash = await hasher.hash('pw');
  const mkUser = (login: string) => userRepo.create({ name: login, email: `${login}@x.com`, login, passwordHash: pwHash, status: 'active' });

  const manageUser = await mkUser('manager');
  await userRoleRepo.assign(manageUser.id, managerRole.id);
  const readUser = await mkUser('reader');
  await userRoleRepo.assign(readUser.id, readerRole.id);
  const noPermUser = await mkUser('noperm');

  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  const wifi = new FakeAdminWifi();
  const provisioning = new FakeProvisioning();
  const getAdminOnuWifiStatus = new GetAdminOnuWifiStatus(wifi);
  const setAdminWifiBand = new SetAdminWifiBand(wifi);
  const enableOnuTr069 = new EnableOnuTr069(provisioning);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(
    '/api/wifi',
    createWifiRouter(new EchoAuthProvider(userRepo), undefined, requirePerm, getAdminOnuWifiStatus, setAdminWifiBand, enableOnuTr069),
  );
  app.use(errorHandler);

  return { app, wifi, provisioning, manageUserId: manageUser.id, readOnlyUserId: readUser.id, noPermUserId: noPermUser.id };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

describe('GET /api/wifi/onu/:serial — admin, wifi.read', () => {
  it('caso 9: staff SÍ ve ip/mac de los hosts (a diferencia del portal)', async () => {
    const fx = await buildApp();
    fx.wifi.statusBySn.set('HWTC189C07AA', ONLINE_STATUS);
    fx.wifi.hostsBySn.set('HWTC189C07AA', [
      { hostName: 'iPhone', ip: '192.168.1.5', mac: 'AA:BB:CC', interfaceType: 'wifi', active: true, vendor: 'Apple' },
    ]);

    const res = await asUser(request(fx.app).get('/api/wifi/onu/HWTC189C07AA'), fx.manageUserId);

    expect(res.status).toBe(200);
    expect(res.body.data.hosts).toEqual([
      { name: 'iPhone', ip: '192.168.1.5', mac: 'AA:BB:CC', interface: 'wifi', active: true, vendor: 'Apple' },
    ]);
  });

  it('sin wifi.read -> 403', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).get('/api/wifi/onu/HWTC1'), fx.noPermUserId);
    expect(res.status).toBe(403);
  });

  it('sin cookie -> 401', async () => {
    const fx = await buildApp();
    const res = await request(fx.app).get('/api/wifi/onu/HWTC1');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/wifi/onu/:serial/enable-tr069 — admin, wifi.manage', () => {
  it('caso 10: sin vlan -> 400 con la pista de vlans conocidas', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).post('/api/wifi/onu/HWTC1/enable-tr069'), fx.manageUserId).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/vlan/i);
    expect(fx.provisioning.calls).toHaveLength(0);
  });

  it('caso 10: con vlan -> llama la cadena EN ORDEN (setMgmtIp ANTES de enableTr069)', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).post('/api/wifi/onu/HWTC1/enable-tr069'), fx.manageUserId).send({ vlan: 11 });

    expect(res.status).toBe(200);
    expect(fx.provisioning.calls).toEqual([
      { method: 'setMgmtIp', sn: 'HWTC1', arg: 11 },
      { method: 'enableTr069', sn: 'HWTC1', arg: 'SmartOLT' },
    ]);
  });

  it('acepta tr069Profile=Wispcontrol explícito (429 ONUs del parque lo usan)', async () => {
    const fx = await buildApp();
    await asUser(request(fx.app).post('/api/wifi/onu/HWTC1/enable-tr069'), fx.manageUserId).send({ vlan: 12, tr069Profile: 'Wispcontrol' });
    expect(fx.provisioning.calls[1]).toEqual({ method: 'enableTr069', sn: 'HWTC1', arg: 'Wispcontrol' });
  });

  it('caso 11: SmartOLT no configurado -> 503 SMARTOLT_NOT_CONFIGURED, nada explota', async () => {
    const fx = await buildApp();
    fx.provisioning.notConfigured = true;
    const res = await asUser(request(fx.app).post('/api/wifi/onu/HWTC1/enable-tr069'), fx.manageUserId).send({ vlan: 11 });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SMARTOLT_NOT_CONFIGURED');
  });
});

describe('caso 11 — SmartOLT no configurado en el resto de las rutas admin', () => {
  it('GET /onu/:serial -> 503 SMARTOLT_NOT_CONFIGURED', async () => {
    const fx = await buildApp();
    fx.wifi.notConfigured = true;
    const res = await asUser(request(fx.app).get('/api/wifi/onu/HWTC1'), fx.manageUserId);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SMARTOLT_NOT_CONFIGURED');
  });

  it('PUT /onu/:serial/band -> 503 SMARTOLT_NOT_CONFIGURED', async () => {
    const fx = await buildApp();
    fx.wifi.notConfigured = true;
    const res = await asUser(request(fx.app).put('/api/wifi/onu/HWTC1/band'), fx.manageUserId).send({ port: 'wifi_0/1', ssid: 'X', password: '12345678' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SMARTOLT_NOT_CONFIGURED');
  });
});
