/**
 * pppoe-management — InMemoryRouterGateway (fake del PppoeRouterGateway) unit tests.
 * Cubre: create/list/update/remove de secrets aislados por router, y simulación de router caído.
 */
import { InMemoryRouterGateway } from '@infrastructure/adapters/in-memory/InMemoryRouterGateway';
import { RouterUnreachableError } from '@domain/errors/pppoe';

const nas = { ipAddress: '10.64.60.2', apiPort: 8728 };

describe('InMemoryRouterGateway', () => {
  it('createSecret + listSecrets devuelve el secret con defaults', async () => {
    const gw = new InMemoryRouterGateway();
    await gw.createSecret(nas, { username: 'u1', password: 'p', profile: 'IP-Air-30-10', remoteAddress: '100.64.0.5' });
    const secrets = await gw.listSecrets(nas);
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.username).toBe('u1');
    expect(secrets[0]!.profile).toBe('IP-Air-30-10');
    expect(secrets[0]!.remoteAddress).toBe('100.64.0.5');
    expect(secrets[0]!.disabled).toBe(false);
  });

  it('updateSecret cambia profile y disabled', async () => {
    const gw = new InMemoryRouterGateway();
    await gw.createSecret(nas, { username: 'u1', password: 'p' });
    await gw.updateSecret(nas, 'u1', { profile: 'IP-REDUCCION', disabled: true });
    const s = (await gw.listSecrets(nas))[0]!;
    expect(s.profile).toBe('IP-REDUCCION');
    expect(s.disabled).toBe(true);
  });

  it('removeSecret lo saca', async () => {
    const gw = new InMemoryRouterGateway();
    await gw.createSecret(nas, { username: 'u1', password: 'p' });
    await gw.removeSecret(nas, 'u1');
    expect(await gw.listSecrets(nas)).toHaveLength(0);
  });

  it('router inalcanzable → RouterUnreachableError', async () => {
    const gw = new InMemoryRouterGateway({ unreachable: ['10.64.10.2'] });
    const down = { ipAddress: '10.64.10.2', apiPort: 8728 };
    await expect(gw.createSecret(down, { username: 'u', password: 'p' })).rejects.toBeInstanceOf(RouterUnreachableError);
    await expect(gw.listSecrets(down)).rejects.toBeInstanceOf(RouterUnreachableError);
  });

  it('los secrets están aislados por router (nas)', async () => {
    const gw = new InMemoryRouterGateway();
    await gw.createSecret({ ipAddress: 'A', apiPort: 8728 }, { username: 'a', password: 'p' });
    await gw.createSecret({ ipAddress: 'B', apiPort: 8728 }, { username: 'b', password: 'p' });
    expect(await gw.listSecrets({ ipAddress: 'A', apiPort: 8728 })).toHaveLength(1);
    expect(await gw.listSecrets({ ipAddress: 'B', apiPort: 8728 })).toHaveLength(1);
  });

  it('removeActiveSession y listActiveSessions disponibles (para Fase C)', async () => {
    const gw = new InMemoryRouterGateway();
    expect(await gw.listActiveSessions(nas)).toEqual([]);
    await expect(gw.removeActiveSession(nas, 'u1')).resolves.toBeUndefined();
  });
});
