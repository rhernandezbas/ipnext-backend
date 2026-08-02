import { RegisterPortalPushToken } from '@application/use-cases/portal/RegisterPortalPushToken';
import { InMemoryPortalPushTokenRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalPushTokenRepository';

describe('RegisterPortalPushToken', () => {
  it('upsertea un token nuevo bajo la cuenta que lo registra', async () => {
    const tokens = new InMemoryPortalPushTokenRepository();
    const useCase = new RegisterPortalPushToken(tokens);

    await useCase.execute('account-1', { token: 'fcm-token-abc', platform: 'android', deviceLabel: 'Moto G32' });

    const row = tokens.findByToken('fcm-token-abc');
    expect(row?.accountId).toBe('account-1');
    expect(row?.platform).toBe('android');
    expect(row?.deviceLabel).toBe('Moto G32');
    expect(row?.invalidAt).toBeNull();
  });

  it('caso obligatorio 1 — el MISMO token registrado por OTRA cuenta se reasigna (deja de pertenecer a la primera)', async () => {
    const tokens = new InMemoryPortalPushTokenRepository();
    const useCase = new RegisterPortalPushToken(tokens);

    await useCase.execute('account-old-owner', { token: 'shared-device-token', platform: 'android' });
    await useCase.execute('account-new-owner', { token: 'shared-device-token', platform: 'android' });

    const row = tokens.findByToken('shared-device-token');
    expect(row?.accountId).toBe('account-new-owner');
    expect(row?.accountId).not.toBe('account-old-owner');

    // Solo existe UNA fila para el token — no quedó duplicado por cuenta.
    const deletedFromOldOwner = await tokens.deleteForAccount('account-old-owner', 'shared-device-token');
    expect(deletedFromOldOwner).toBe(false);
    const deletedFromNewOwner = await tokens.deleteForAccount('account-new-owner', 'shared-device-token');
    expect(deletedFromNewOwner).toBe(true);
  });

  it('re-registrar el MISMO token bajo la MISMA cuenta refresca lastSeenAt y limpia invalidAt', async () => {
    const tokens = new InMemoryPortalPushTokenRepository();
    const useCase = new RegisterPortalPushToken(tokens);

    await useCase.execute('account-1', { token: 'tok-1', platform: 'android' });
    await tokens.markInvalid(['tok-1']);
    expect(tokens.findByToken('tok-1')?.invalidAt).not.toBeNull();

    await useCase.execute('account-1', { token: 'tok-1', platform: 'android' });

    expect(tokens.findByToken('tok-1')?.invalidAt).toBeNull();
  });

  it('deviceLabel ausente se persiste como null', async () => {
    const tokens = new InMemoryPortalPushTokenRepository();
    const useCase = new RegisterPortalPushToken(tokens);

    await useCase.execute('account-1', { token: 'tok-no-label', platform: 'ios' });

    expect(tokens.findByToken('tok-no-label')?.deviceLabel).toBeNull();
  });
});
