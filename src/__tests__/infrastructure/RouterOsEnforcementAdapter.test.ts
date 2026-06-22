import { RouterOsEnforcementAdapter } from '@infrastructure/adapters/routeros/RouterOsEnforcementAdapter';
import { InMemoryRouterGateway } from '@infrastructure/adapters/in-memory/InMemoryRouterGateway';
import { PppoeService } from '@domain/entities/pppoeService';
import { NasServer } from '@domain/entities/nas';

const NAS_IP = '192.168.1.1';
const REDUCED = 'IP-REDUCCION';
const COMMERCIAL = 'IP-Air-5M';

const nas: NasServer = {
  id: '1', name: 'r1', type: 'mikrotik_api', ipAddress: NAS_IP,
  radiusSecret: '', nasIpAddress: '', apiPort: 8728, apiLogin: null, apiPassword: null,
  status: 'active', lastSeen: null, clientCount: 0, description: '',
};

function pppoe(over: Partial<PppoeService> = {}): PppoeService {
  return {
    id: 'p1', username: 'cliente1', password: 'pw', profile: COMMERCIAL,
    remoteAddress: null, status: 'enabled', nasId: '1', contractId: 'c1',
    enforcedState: 'active', callerId: null, createdAt: '2026-01-01', ...over,
  };
}

async function routerSecret(router: InMemoryRouterGateway, username: string) {
  const secrets = await router.listSecrets({ ipAddress: NAS_IP, apiPort: 8728 });
  return secrets.find((x) => x.username === username)!;
}

async function setup() {
  const router = new InMemoryRouterGateway({ unreachable: [] });
  await router.createSecret({ ipAddress: NAS_IP, apiPort: 8728 }, {
    username: 'cliente1', password: 'pw', profile: COMMERCIAL, disabled: false,
  });
  router.seedSession(NAS_IP, { username: 'cliente1', address: '10.1.1.1', callerId: 'aa:bb', uptime: '1h' });
  const adapter = new RouterOsEnforcementAdapter(router, REDUCED);
  return { router, adapter };
}

describe('RouterOsEnforcementAdapter (Inc1 — corte MK-directo detrás del EnforcementGateway)', () => {
  it('reduce: profile reducido en router + kick', async () => {
    const { router, adapter } = await setup();
    await adapter.apply(pppoe(), nas, 'reduce');
    const secret = await routerSecret(router, 'cliente1');
    expect(secret.profile).toBe(REDUCED);
    expect(secret.disabled).toBe(false);
    expect(await router.listActiveSessions({ ipAddress: NAS_IP, apiPort: 8728 })).toHaveLength(0);
  });

  it('block: secret disabled=yes + kick', async () => {
    const { router, adapter } = await setup();
    await adapter.apply(pppoe(), nas, 'block');
    const secret = await routerSecret(router, 'cliente1');
    expect(secret.disabled).toBe(true);
    expect(await router.listActiveSessions({ ipAddress: NAS_IP, apiPort: 8728 })).toHaveLength(0);
  });

  it('restore: vuelve al profile comercial + disabled=no', async () => {
    const { router, adapter } = await setup();
    await adapter.apply(pppoe(), nas, 'restore');
    const secret = await routerSecret(router, 'cliente1');
    expect(secret.profile).toBe(COMMERCIAL);
    expect(secret.disabled).toBe(false);
  });

  it('restore RESPETA la baja comercial: status=disabled NO re-habilita el secret', async () => {
    const { router, adapter } = await setup();
    await adapter.apply(pppoe({ status: 'disabled' }), nas, 'restore');
    const secret = await routerSecret(router, 'cliente1');
    expect(secret.disabled).toBe(true);
  });

  it('restore con profile comercial null NO pisa el profile del router con vacío', async () => {
    const { router, adapter } = await setup();
    await adapter.apply(pppoe({ profile: null }), nas, 'restore');
    const secret = await routerSecret(router, 'cliente1');
    expect(secret.profile).toBe(COMMERCIAL); // queda el que tenía el router
  });
});
