import { RegisterPortalPushToken } from '@application/use-cases/portal/RegisterPortalPushToken';
import { UnregisterPortalPushToken } from '@application/use-cases/portal/UnregisterPortalPushToken';
import { InMemoryPortalPushTokenRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalPushTokenRepository';

describe('UnregisterPortalPushToken', () => {
  it('borra el token propio de la cuenta', async () => {
    const tokens = new InMemoryPortalPushTokenRepository();
    const register = new RegisterPortalPushToken(tokens);
    const unregister = new UnregisterPortalPushToken(tokens);
    await register.execute('account-1', { token: 'tok-mine', platform: 'android' });

    const deleted = await unregister.execute('account-1', 'tok-mine');

    expect(deleted).toBe(true);
    expect(tokens.findByToken('tok-mine')).toBeUndefined();
  });

  it('caso obligatorio 2 — el token de OTRA cuenta NO se borra (y no filtra si existía)', async () => {
    const tokens = new InMemoryPortalPushTokenRepository();
    const register = new RegisterPortalPushToken(tokens);
    const unregister = new UnregisterPortalPushToken(tokens);
    await register.execute('account-owner', { token: 'tok-ajeno', platform: 'android' });

    const deleted = await unregister.execute('account-attacker', 'tok-ajeno');

    expect(deleted).toBe(false);
    // El token del dueño real sigue intacto — el intento ajeno no lo tocó.
    expect(tokens.findByToken('tok-ajeno')?.accountId).toBe('account-owner');
  });

  it('borrar un token inexistente devuelve false sin lanzar (mismo shape de respuesta que "es de otro")', async () => {
    const tokens = new InMemoryPortalPushTokenRepository();
    const unregister = new UnregisterPortalPushToken(tokens);

    await expect(unregister.execute('account-1', 'tok-que-nunca-existio')).resolves.toBe(false);
  });
});
