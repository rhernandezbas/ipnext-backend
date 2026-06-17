import { EnforcePppoeService } from '@application/use-cases/EnforcePppoeService';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryRouterGateway } from '@infrastructure/adapters/in-memory/InMemoryRouterGateway';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import {
  RouterUnreachableError,
  PppoeServiceNotFoundError,
  NasNotFoundError,
} from '@domain/errors/pppoe';

const NAS_ID = '1';
const NAS_IP = '192.168.1.1';
const REDUCED = 'IP-REDUCCION';
const COMMERCIAL = 'IP-Air-5M';

async function setup(opts?: { unreachable?: string[] }) {
  const repo = new InMemoryPppoeServiceRepository();
  const router = new InMemoryRouterGateway({ unreachable: opts?.unreachable ?? [] });
  const nasRepo = new InMemoryNasRepository();
  const enforce = new EnforcePppoeService(repo, router, nasRepo, REDUCED);
  return { repo, router, nasRepo, enforce };
}

async function seed(
  repo: InMemoryPppoeServiceRepository,
  router: InMemoryRouterGateway,
  opts: { username?: string; profile?: string | null; enforcedState?: 'active' | 'reduced' | 'blocked'; status?: string; routerProfile?: string; routerDisabled?: boolean; withSession?: boolean; skipRouterSeed?: boolean } = {},
) {
  const username = opts.username ?? 'cliente1';
  const profile = opts.profile !== undefined ? opts.profile : COMMERCIAL;
  const s = await repo.upsertByUsername({
    username, password: 'pw', profile, nasId: NAS_ID, contractId: 'c1',
    status: opts.status ?? 'enabled', enforcedState: opts.enforcedState ?? 'active',
  });
  if (!opts.skipRouterSeed) {
    await router.createSecret({ ipAddress: NAS_IP, apiPort: 8728 }, {
      username, password: 'pw',
      profile: opts.routerProfile ?? profile,
      disabled: opts.routerDisabled ?? false,
    });
  }
  if (opts.withSession) {
    router.seedSession(NAS_IP, { username, address: '10.1.1.1', callerId: 'aa:bb', uptime: '1h' });
  }
  return s;
}

async function routerSecret(router: InMemoryRouterGateway, username: string) {
  const secrets = await router.listSecrets({ ipAddress: NAS_IP, apiPort: 8728 });
  return secrets.find(x => x.username === username)!;
}

describe('EnforcePppoeService (Fase C — corte individual)', () => {
  it('reduce: profile reducido en router + kick + enforcedState=reduced, profile comercial intacto en DB', async () => {
    const { repo, router, enforce } = await setup();
    const s = await seed(repo, router, { withSession: true });

    const out = await enforce.execute({ id: s.id, action: 'reduce' });

    expect(out.enforcedState).toBe('reduced');
    expect(out.profile).toBe(COMMERCIAL); // DB conserva el comercial
    const secret = await routerSecret(router, s.username);
    expect(secret.profile).toBe(REDUCED);
    expect(secret.disabled).toBe(false);
    const sessions = await router.listActiveSessions({ ipAddress: NAS_IP, apiPort: 8728 });
    expect(sessions).toHaveLength(0); // kickeado
  });

  it('block: secret disabled=yes + kick + enforcedState=blocked, profile comercial intacto', async () => {
    const { repo, router, enforce } = await setup();
    const s = await seed(repo, router, { withSession: true });

    const out = await enforce.execute({ id: s.id, action: 'block' });

    expect(out.enforcedState).toBe('blocked');
    expect(out.profile).toBe(COMMERCIAL);
    const secret = await routerSecret(router, s.username);
    expect(secret.disabled).toBe(true);
    const sessions = await router.listActiveSessions({ ipAddress: NAS_IP, apiPort: 8728 });
    expect(sessions).toHaveLength(0);
  });

  it('restore: vuelve al profile comercial + disabled=no + kick + enforcedState=active', async () => {
    const { repo, router, enforce } = await setup();
    const s = await seed(repo, router, {
      enforcedState: 'reduced', routerProfile: REDUCED, withSession: true,
    });

    const out = await enforce.execute({ id: s.id, action: 'restore' });

    expect(out.enforcedState).toBe('active');
    const secret = await routerSecret(router, s.username);
    expect(secret.profile).toBe(COMMERCIAL); // recupera el comercial de la DB
    expect(secret.disabled).toBe(false);
  });

  it('restore RESPETA la baja comercial: un secret status=disabled NO se re-habilita (queda disabled, enforcedState=active)', async () => {
    const { repo, router, enforce } = await setup();
    // reduced + comercialmente dado de baja (status=disabled)
    const s = await seed(repo, router, {
      enforcedState: 'reduced', status: 'disabled', routerProfile: REDUCED, routerDisabled: true,
    });

    const out = await enforce.execute({ id: s.id, action: 'restore' });

    expect(out.enforcedState).toBe('active');
    const secret = await routerSecret(router, s.username);
    expect(secret.disabled).toBe(true); // NO se re-habilita al dado de baja comercial
  });

  it('restore con profile comercial null NO manda profile vacío al router (conserva el del router)', async () => {
    const { repo, router, enforce } = await setup();
    const s = await seed(repo, router, {
      enforcedState: 'reduced', profile: null, routerProfile: REDUCED,
    });

    const out = await enforce.execute({ id: s.id, action: 'restore' });

    expect(out.enforcedState).toBe('active');
    const secret = await routerSecret(router, s.username);
    // no se pisó con vacío: el profile del router queda como estaba (no '' ni null forzado)
    expect(secret.profile).toBe(REDUCED);
  });

  it('idempotente: reduce sobre uno YA reduced = no-op (ni toca el router → sobrevive router caído)', async () => {
    const { repo, router, enforce } = await setup({ unreachable: [NAS_IP] });
    const s = await seed(repo, router, { enforcedState: 'reduced', skipRouterSeed: true });

    // No debe lanzar (no toca el router): es no-op
    const out = await enforce.execute({ id: s.id, action: 'reduce' });
    expect(out.enforcedState).toBe('reduced');
  });

  it('router caído: 502 ROUTER_UNREACHABLE y enforcedState NO cambia (no miente)', async () => {
    const { repo, router, enforce } = await setup({ unreachable: [NAS_IP] });
    const s = await seed(repo, router, { enforcedState: 'active', skipRouterSeed: true });

    await expect(enforce.execute({ id: s.id, action: 'reduce' })).rejects.toBeInstanceOf(RouterUnreachableError);
    const after = await repo.findById(s.id);
    expect(after?.enforcedState).toBe('active');
  });

  it('PPPoE inexistente → PppoeServiceNotFoundError', async () => {
    const { enforce } = await setup();
    await expect(enforce.execute({ id: 'no-existe', action: 'reduce' })).rejects.toBeInstanceOf(PppoeServiceNotFoundError);
  });

  it('NAS inexistente → NasNotFoundError', async () => {
    const { repo, router, enforce } = await setup();
    const s = await repo.upsertByUsername({
      username: 'huerfano', password: 'pw', profile: COMMERCIAL,
      nasId: 'nas-99', contractId: 'c1', status: 'enabled', enforcedState: 'active',
    });
    await router.createSecret({ ipAddress: NAS_IP, apiPort: 8728 }, { username: 'huerfano', password: 'pw' });
    await expect(enforce.execute({ id: s.id, action: 'reduce' })).rejects.toBeInstanceOf(NasNotFoundError);
  });
});
