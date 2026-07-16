/**
 * fiber.routes.test.ts — supertest para las rutas de aprovisionamiento de fibra (K2).
 *
 * Cubre el contrato wire completo:
 *  - 401 sin auth / 403 sin permiso (network.read para leer, network.manage para
 *    aprovisionar, admin.manage para editar el catálogo de OLTs).
 *  - Flag 'fiber-auto-provision' OFF → 409 FIBER_PROVISION_DISABLED (provision + picker).
 *  - Envs SMARTOLT_* ausentes → 503 SMARTOLT_NOT_CONFIGURED (feature apagada limpia).
 *  - Config de OLTs accesible AUN con flag OFF (patrón gigared /config: primero
 *    configurás, después prendés).
 *  - POST /provision: Zod 400, happy 200, dryRun 200 sin calls, errores tipados
 *    (ONU_NOT_HUAWEI / FIBER_VLAN_REQUIRED) vía errorHandler global.
 *
 * Patrón espejo de nas.routes.test.ts (EchoAuthProvider + cookie token = userId + RBAC in-memory).
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { createFiberRouter } from '@infrastructure/http/routes/fiber.routes';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { requirePermission } from '@infrastructure/http/middleware/requirePermission';

import { InMemoryOltProvisioningGateway } from '@infrastructure/adapters/in-memory/InMemoryOltProvisioningGateway';
import { InMemorySmartOltOltConfigRepository } from '@infrastructure/adapters/in-memory/InMemorySmartOltOltConfigRepository';
import { InMemoryFeatureFlagRepository } from '@infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryRouterGateway } from '@infrastructure/adapters/in-memory/InMemoryRouterGateway';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryGestionRealPort } from '@infrastructure/adapters/in-memory/InMemoryGestionRealPort';
import { InMemoryGestionRealIngestConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryGestionRealIngestConfigRepository';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';

import {
  ProvisionFiberOnu,
  FiberContractLookup,
  FiberContractSnapshot,
  FiberInstallTaskWriter,
} from '@application/use-cases/ProvisionFiberOnu';
import { ListUnconfiguredOnus } from '@application/use-cases/ListUnconfiguredOnus';
import { ListSmartOltOlts } from '@application/use-cases/ListSmartOltOlts';
import { UpdateSmartOltOlt } from '@application/use-cases/UpdateSmartOltOlt';
import { PregenInstallPppoe } from '@application/use-cases/PregenInstallPppoe';
import { CreatePppoeService } from '@application/use-cases/CreatePppoeService';
import { EnsureInternetContractService } from '@application/use-cases/EnsureInternetContractService';

import { AuthProvider } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';

const SN = 'HWTC11112222';
const FLAG = 'fiber-auto-provision';

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

class FakeContractLookup implements FiberContractLookup {
  contracts = new Map<string, FiberContractSnapshot>();
  async findById(id: string): Promise<FiberContractSnapshot | null> {
    const c = this.contracts.get(id);
    return c ? { ...c } : null;
  }
}

class FakeInstallTaskWriter implements FiberInstallTaskWriter {
  tasks: Array<{ id: string; contractId: string; description: string | null }> = [];
  async findLatestByContract(contractId: string): Promise<{ id: string; description: string | null } | null> {
    const t = [...this.tasks].reverse().find(x => x.contractId === contractId);
    return t ? { id: t.id, description: t.description } : null;
  }
  async updateDescription(taskId: string, description: string): Promise<void> {
    const t = this.tasks.find(x => x.id === taskId);
    if (t) t.description = description;
  }
}

interface Fixture {
  app: express.Express;
  gateway: InMemoryOltProvisioningGateway;
  oltRepo: InMemorySmartOltOltConfigRepository;
  pppoeRepo: InMemoryPppoeServiceRepository;
  flags: InMemoryFeatureFlagRepository;
  managerUserId: string;
  readerUserId: string;
  noPermUserId: string;
}

async function buildApp(opts?: {
  flagEnabled?: boolean;
  /** false = la tabla NO tiene la fila del flag (fail-closed esperado). */
  flagSeeded?: boolean;
  configured?: boolean;
}): Promise<Fixture> {
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

  const managerRole = await roleRepo.create({ code: 'fiber_manager', label: 'Fiber Manager', isSystem: false });
  const readerRole  = await roleRepo.create({ code: 'fiber_reader', label: 'Fiber Reader', isSystem: false });
  const readPerm    = await permRepo.seed({ moduleCode: 'network', action: 'read' });
  const managePerm  = await permRepo.seed({ moduleCode: 'network', action: 'manage' });
  const adminPerm   = await permRepo.seed({ moduleCode: 'admin', action: 'manage' });
  await rolePermRepo.grant(managerRole.id, readPerm.id);
  await rolePermRepo.grant(managerRole.id, managePerm.id);
  await rolePermRepo.grant(managerRole.id, adminPerm.id);
  await rolePermRepo.grant(readerRole.id, readPerm.id);

  const pwHash = await hasher.hash('pw');
  const mkUser = (login: string) =>
    userRepo.create({ name: login, email: `${login}@x.com`, login, passwordHash: pwHash, status: 'active' });

  const manager = await mkUser('manager');
  const reader  = await mkUser('reader');
  const noPerm  = await mkUser('noperm');
  await userRoleRepo.assign(manager.id, managerRole.id);
  await userRoleRepo.assign(reader.id, readerRole.id);

  // ── deps del feature ──
  const gateway = new InMemoryOltProvisioningGateway();
  gateway.unconfigured = [
    {
      sn: SN,
      onuTypeName: 'HG8546M',
      onuTypeId: '15',
      oltId: '1',
      board: '0',
      port: '3',
      ponType: 'gpon',
      supportsAuthorize: true,
    },
  ];

  const oltRepo = new InMemorySmartOltOltConfigRepository();
  oltRepo.seed({ id: 'olt-m1', smartoltOltId: '1', name: 'MERCEDES1', serviceVlanDefault: 246, mgmtVlan: 11 });
  oltRepo.seed({ id: 'olt-ch', smartoltOltId: '3', name: 'CHIVILCOY X2', serviceVlanDefault: null, mgmtVlan: null });

  const flags = new InMemoryFeatureFlagRepository();
  if (opts?.flagSeeded ?? true) flags.seed(FLAG, opts?.flagEnabled ?? true);

  const contracts = new FakeContractLookup();
  contracts.contracts.set('ctr-1', {
    id: 'ctr-1',
    plan: '300MB',
    grContratoId: '45123',
    clientId: 'cli-1',
    clientName: 'HERNANDEZ RONALD',
    grClienteId: 'gr-cli-1',
  });

  const pppoeRepo = new InMemoryPppoeServiceRepository();
  const createPppoe = new CreatePppoeService(
    pppoeRepo,
    new InMemoryRouterGateway(),
    new InMemoryNasRepository(),
    new InMemoryRadiusOrchestratorGateway(),
    new EnsureInternetContractService(
      new InMemoryContractServiceRepository(),
      new InMemoryServiceCatalogRepository(),
    ),
  );
  const pregen = new PregenInstallPppoe(pppoeRepo, createPppoe, new InMemoryGestionRealPort());
  const ingestConfig = new InMemoryGestionRealIngestConfigRepository();
  await ingestConfig.update({ pppoeProfile: 'IP-FTTH-300' });

  const provisionFiberOnu = new ProvisionFiberOnu(
    gateway,
    oltRepo,
    contracts,
    pppoeRepo,
    pregen,
    ingestConfig,
    new FakeInstallTaskWriter(),
    { rng: () => 0.7 },
  );

  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/fiber', createFiberRouter(
    new EchoAuthProvider(),
    undefined,
    requirePerm,
    flags,
    opts?.configured ?? true,
    new ListUnconfiguredOnus(gateway, oltRepo),
    provisionFiberOnu,
    new ListSmartOltOlts(oltRepo),
    new UpdateSmartOltOlt(oltRepo),
  ));
  app.use(errorHandler);

  return {
    app,
    gateway,
    oltRepo,
    pppoeRepo,
    flags,
    managerUserId: manager.id,
    readerUserId: reader.id,
    noPermUserId: noPerm.id,
  };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

describe('fiber.routes — auth y permisos', () => {
  it('GET /api/fiber/unconfigured-onus sin auth → 401', async () => {
    const { app } = await buildApp();
    expect((await request(app).get('/api/fiber/unconfigured-onus')).status).toBe(401);
  });

  it('POST /api/fiber/provision sin auth → 401', async () => {
    const { app } = await buildApp();
    expect((await request(app).post('/api/fiber/provision').send({})).status).toBe(401);
  });

  it('POST /api/fiber/provision con network.read pero SIN network.manage → 403', async () => {
    const fx = await buildApp();
    const res = await asUser(
      request(fx.app).post('/api/fiber/provision').send({ contractId: 'ctr-1', onuSn: SN }),
      fx.readerUserId,
    );
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
    expect(fx.gateway.calls).toHaveLength(0);
  });

  it('GET /api/fiber/unconfigured-onus sin network.read → 403', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).get('/api/fiber/unconfigured-onus'), fx.noPermUserId);
    expect(res.status).toBe(403);
  });

  it('PUT /api/fiber/olts/:id sin admin.manage (reader) → 403', async () => {
    const fx = await buildApp();
    const res = await asUser(
      request(fx.app).put('/api/fiber/olts/olt-ch').send({ serviceVlanDefault: 1500 }),
      fx.readerUserId,
    );
    expect(res.status).toBe(403);
  });
});

describe('fiber.routes — gates de feature (flag + envs)', () => {
  it('flag OFF → 409 FIBER_PROVISION_DISABLED en provision y en el picker', async () => {
    const fx = await buildApp({ flagEnabled: false });

    const provision = await asUser(
      request(fx.app).post('/api/fiber/provision').send({ contractId: 'ctr-1', onuSn: SN }),
      fx.managerUserId,
    );
    expect(provision.status).toBe(409);
    expect(provision.body.code).toBe('FIBER_PROVISION_DISABLED');

    const picker = await asUser(request(fx.app).get('/api/fiber/unconfigured-onus'), fx.readerUserId);
    expect(picker.status).toBe(409);
    expect(picker.body.code).toBe('FIBER_PROVISION_DISABLED');

    expect(fx.gateway.calls).toHaveLength(0);
  });

  it('flag AUSENTE de la tabla → mismo 409 (fail-closed)', async () => {
    const fx = await buildApp({ flagSeeded: false });
    const res = await asUser(
      request(fx.app).post('/api/fiber/provision').send({ contractId: 'ctr-1', onuSn: SN }),
      fx.managerUserId,
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('FIBER_PROVISION_DISABLED');
    expect(fx.gateway.calls).toHaveLength(0);
  });

  it('envs SMARTOLT_* ausentes → 503 SMARTOLT_NOT_CONFIGURED aunque el flag esté ON', async () => {
    const fx = await buildApp({ configured: false });

    const res = await asUser(
      request(fx.app).post('/api/fiber/provision').send({ contractId: 'ctr-1', onuSn: SN }),
      fx.managerUserId,
    );
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SMARTOLT_NOT_CONFIGURED');
    expect(fx.gateway.calls).toHaveLength(0);
  });

  it('la config de OLTs sigue accesible con flag OFF (primero configurar, después prender)', async () => {
    const fx = await buildApp({ flagEnabled: false });

    const list = await asUser(request(fx.app).get('/api/fiber/olts'), fx.readerUserId);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(2);

    const update = await asUser(
      request(fx.app).put('/api/fiber/olts/olt-ch').send({ serviceVlanDefault: 1500 }),
      fx.managerUserId,
    );
    expect(update.status).toBe(200);
    expect(update.body.data.serviceVlanDefault).toBe(1500);
  });
});

describe('fiber.routes — GET /unconfigured-onus (picker)', () => {
  it('200 con la lista enriquecida (huawei/authorizable/vlanRequired)', async () => {
    const fx = await buildApp();

    const res = await asUser(request(fx.app).get('/api/fiber/unconfigured-onus'), fx.readerUserId);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      {
        sn: SN,
        onuTypeName: 'HG8546M',
        oltId: '1',
        oltName: 'MERCEDES1',
        board: '0',
        port: '3',
        ponType: 'gpon',
        huawei: true,
        authorizable: true,
        serviceVlanDefault: 246,
        vlanRequired: false,
      },
    ]);
  });
});

describe('fiber.routes — POST /provision', () => {
  it('body inválido (sin onuSn) → 400 VALIDATION_ERROR, sin tocar el gateway', async () => {
    const fx = await buildApp();
    const res = await asUser(
      request(fx.app).post('/api/fiber/provision').send({ contractId: 'ctr-1' }),
      fx.managerUserId,
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(fx.gateway.calls).toHaveLength(0);
  });

  it('vlan no numérica → 400 VALIDATION_ERROR', async () => {
    const fx = await buildApp();
    const res = await asUser(
      request(fx.app).post('/api/fiber/provision').send({ contractId: 'ctr-1', onuSn: SN, vlan: 'x' }),
      fx.managerUserId,
    );
    expect(res.status).toBe(400);
  });

  it('happy path → 200 con el resultado ejecutado (vlan default, wifi, steps, pppoe)', async () => {
    const fx = await buildApp();

    const res = await asUser(
      request(fx.app).post('/api/fiber/provision').send({ contractId: 'ctr-1', onuSn: SN }),
      fx.managerUserId,
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      dryRun: false,
      contractId: 'ctr-1',
      onuSn: SN,
      olt: { smartoltOltId: '1', name: 'MERCEDES1' },
      vlan: 246,
      wifi: { ssid24: 'IPNEXT_HERNANDEZ_2.4', ssid5: 'IPNEXT_HERNANDEZ_5', password: '45123777' },
      pppoe: { status: 'created', username: 'ronaldhernandez45123' },
    });
    expect(res.body.data.steps).toHaveLength(6);
    expect(fx.gateway.writeSequence()[0]).toBe('authorizeOnu');
  });

  it('dryRun=true → 200 con el PLAN y CERO llamadas al gateway', async () => {
    const fx = await buildApp();

    const res = await asUser(
      request(fx.app)
        .post('/api/fiber/provision')
        .send({ contractId: 'ctr-1', onuSn: SN, vlan: 246, dryRun: true }),
      fx.managerUserId,
    );

    expect(res.status).toBe(200);
    expect(res.body.data.dryRun).toBe(true);
    expect(res.body.data.plan).toHaveLength(7);
    expect(fx.gateway.calls).toHaveLength(0);
    expect(await fx.pppoeRepo.findByContract('ctr-1')).toHaveLength(0);
  });

  it('ONU no-Huawei → 422 ONU_NOT_HUAWEI (errorHandler global)', async () => {
    const fx = await buildApp();
    const res = await asUser(
      request(fx.app).post('/api/fiber/provision').send({ contractId: 'ctr-1', onuSn: 'ZTEGC1234567' }),
      fx.managerUserId,
    );
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('ONU_NOT_HUAWEI');
  });

  it('CHIVILCOY sin vlan → 422 FIBER_VLAN_REQUIRED', async () => {
    const fx = await buildApp();
    fx.gateway.unconfigured[0]!.oltId = '3';
    const res = await asUser(
      request(fx.app).post('/api/fiber/provision').send({ contractId: 'ctr-1', onuSn: SN }),
      fx.managerUserId,
    );
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('FIBER_VLAN_REQUIRED');
  });

  it('contrato inexistente → 404 CONTRACT_NOT_FOUND', async () => {
    const fx = await buildApp();
    const res = await asUser(
      request(fx.app).post('/api/fiber/provision').send({ contractId: 'nope', onuSn: SN }),
      fx.managerUserId,
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CONTRACT_NOT_FOUND');
  });
});

describe('fiber.routes — catálogo de OLTs', () => {
  it('GET /olts → 200 lista completa (network.read alcanza)', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).get('/api/fiber/olts'), fx.readerUserId);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { id: 'olt-m1', smartoltOltId: '1', name: 'MERCEDES1', serviceVlanDefault: 246, mgmtVlan: 11 },
      { id: 'olt-ch', smartoltOltId: '3', name: 'CHIVILCOY X2', serviceVlanDefault: null, mgmtVlan: null },
    ]);
  });

  it('PUT /olts/:id con admin.manage → 200 con la fila actualizada', async () => {
    const fx = await buildApp();
    const res = await asUser(
      request(fx.app).put('/api/fiber/olts/olt-m1').send({ mgmtVlan: null }),
      fx.managerUserId,
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: 'olt-m1', mgmtVlan: null, serviceVlanDefault: 246 });
  });

  it('PUT /olts/:id inexistente → 404 SMARTOLT_OLT_NOT_FOUND', async () => {
    const fx = await buildApp();
    const res = await asUser(
      request(fx.app).put('/api/fiber/olts/nope').send({ mgmtVlan: 1 }),
      fx.managerUserId,
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SMARTOLT_OLT_NOT_FOUND');
  });

  it('PUT /olts/:id con vlan inválida (string) → 400 VALIDATION_ERROR', async () => {
    const fx = await buildApp();
    const res = await asUser(
      request(fx.app).put('/api/fiber/olts/olt-m1').send({ serviceVlanDefault: 'abc' }),
      fx.managerUserId,
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});
