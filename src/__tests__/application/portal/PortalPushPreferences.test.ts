/**
 * push-per-device — GetPortalPushPreferences/UpdatePortalPushPreferences YA
 * NO leen `PortalPushPreferenceRepository` (huérfano, ver su docblock):
 * ambos casos operan sobre `PortalPushTokenRepository`, con `token`
 * obligatorio y ownership check (`findForAccount`) — anti-IDOR estructural.
 */
import { GetPortalPushPreferences } from '@application/use-cases/portal/GetPortalPushPreferences';
import { UpdatePortalPushPreferences } from '@application/use-cases/portal/UpdatePortalPushPreferences';
import { RegisterPortalPushToken } from '@application/use-cases/portal/RegisterPortalPushToken';
import { InMemoryPortalPushTokenRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalPushTokenRepository';

async function registerToken(tokens: InMemoryPortalPushTokenRepository, accountId: string, token: string) {
  const register = new RegisterPortalPushToken(tokens);
  await register.execute(accountId, { token, platform: 'android' });
}

describe('GetPortalPushPreferences', () => {
  it('caso obligatorio 3 — devuelve los defaults del TOKEN recién registrado: serviceAlerts=true, promos=false', async () => {
    const tokens = new InMemoryPortalPushTokenRepository();
    await registerToken(tokens, 'account-1', 'dev-1');
    const useCase = new GetPortalPushPreferences(tokens);

    const dto = await useCase.execute('account-1', 'dev-1');

    expect(dto?.serviceAlerts).toBe(true);
    expect(dto?.promos).toBe(false);
  });

  it('caso obligatorio 2 (unit) — token de OTRA cuenta devuelve null (anti-IDOR, el caller lo mapea a 404)', async () => {
    const tokens = new InMemoryPortalPushTokenRepository();
    await registerToken(tokens, 'account-owner', 'owner-dev');
    const useCase = new GetPortalPushPreferences(tokens);

    const dto = await useCase.execute('account-attacker', 'owner-dev');

    expect(dto).toBeNull();
  });

  it('token inexistente devuelve null — MISMO resultado que "es de otra cuenta"', async () => {
    const tokens = new InMemoryPortalPushTokenRepository();
    const useCase = new GetPortalPushPreferences(tokens);

    const dto = await useCase.execute('account-1', 'nunca-existio');

    expect(dto).toBeNull();
  });

  it('llamadas repetidas devuelven el estado ACTUAL del token (no crea uno nuevo por request)', async () => {
    const tokens = new InMemoryPortalPushTokenRepository();
    await registerToken(tokens, 'account-1', 'dev-1');
    const useCase = new GetPortalPushPreferences(tokens);

    await useCase.execute('account-1', 'dev-1');
    await tokens.updatePreferences('account-1', 'dev-1', { serviceAlerts: false });

    const dto = await useCase.execute('account-1', 'dev-1');
    expect(dto?.serviceAlerts).toBe(false);
  });
});

describe('UpdatePortalPushPreferences', () => {
  it('caso obligatorio 4 — promos false->true estampa promosOptInAt y promosOptInAppVersion EN EL TOKEN', async () => {
    const tokens = new InMemoryPortalPushTokenRepository();
    await registerToken(tokens, 'account-1', 'dev-1');
    const fixedNow = new Date('2026-08-01T12:00:00.000Z');
    const useCase = new UpdatePortalPushPreferences(tokens, () => fixedNow);

    const dto = await useCase.execute('account-1', { token: 'dev-1', promos: true }, '1.4.0');

    expect(dto?.promos).toBe(true);
    const raw = await tokens.findForAccount('account-1', 'dev-1');
    expect(raw?.promosOptInAt).toBe(fixedNow.toISOString());
    expect(raw?.promosOptInAppVersion).toBe('1.4.0');
  });

  it('promos false->true sin header X-App-Version estampa promosOptInAppVersion=null (no bloquea el opt-in)', async () => {
    const tokens = new InMemoryPortalPushTokenRepository();
    await registerToken(tokens, 'account-1', 'dev-1');
    const useCase = new UpdatePortalPushPreferences(tokens);

    await useCase.execute('account-1', { token: 'dev-1', promos: true }, null);

    const raw = await tokens.findForAccount('account-1', 'dev-1');
    expect(raw?.promosOptInAppVersion).toBeNull();
    expect(raw?.promosOptInAt).not.toBeNull();
  });

  it('caso obligatorio 4 — promos true->false CONSERVA el estampado histórico (no lo borra)', async () => {
    const tokens = new InMemoryPortalPushTokenRepository();
    await registerToken(tokens, 'account-1', 'dev-1');
    const optInAt = new Date('2026-07-01T09:00:00.000Z');
    const useCase = new UpdatePortalPushPreferences(tokens, () => optInAt);
    await useCase.execute('account-1', { token: 'dev-1', promos: true }, '1.4.0');

    const laterUseCase = new UpdatePortalPushPreferences(tokens, () => new Date('2026-08-01T00:00:00.000Z'));
    const dto = await laterUseCase.execute('account-1', { token: 'dev-1', promos: false }, '1.5.0');

    expect(dto?.promos).toBe(false);
    const raw = await tokens.findForAccount('account-1', 'dev-1');
    // El estampado ORIGINAL sigue ahí, sin pisar con el "1.5.0"/fecha del apagado.
    expect(raw?.promosOptInAt).toBe(optInAt.toISOString());
    expect(raw?.promosOptInAppVersion).toBe('1.4.0');
  });

  it('promos true->true (no-op real) NO re-estampa el opt-in original', async () => {
    const tokens = new InMemoryPortalPushTokenRepository();
    await registerToken(tokens, 'account-1', 'dev-1');
    const optInAt = new Date('2026-07-01T09:00:00.000Z');
    const useCase = new UpdatePortalPushPreferences(tokens, () => optInAt);
    await useCase.execute('account-1', { token: 'dev-1', promos: true }, '1.4.0');

    const laterUseCase = new UpdatePortalPushPreferences(tokens, () => new Date('2026-08-01T00:00:00.000Z'));
    await laterUseCase.execute('account-1', { token: 'dev-1', promos: true }, '1.5.0');

    const raw = await tokens.findForAccount('account-1', 'dev-1');
    expect(raw?.promosOptInAt).toBe(optInAt.toISOString());
    expect(raw?.promosOptInAppVersion).toBe('1.4.0');
  });

  it('actualizar solo serviceAlerts no toca promos ni su histórico de opt-in', async () => {
    const tokens = new InMemoryPortalPushTokenRepository();
    await registerToken(tokens, 'account-1', 'dev-1');
    const useCase = new UpdatePortalPushPreferences(tokens);

    const dto = await useCase.execute('account-1', { token: 'dev-1', serviceAlerts: false }, null);

    expect(dto?.serviceAlerts).toBe(false);
    expect(dto?.promos).toBe(false);
  });

  it('caso obligatorio 2 — token de OTRA cuenta devuelve null y NO escribe nada (anti-IDOR)', async () => {
    const tokens = new InMemoryPortalPushTokenRepository();
    await registerToken(tokens, 'account-owner', 'owner-dev');
    const useCase = new UpdatePortalPushPreferences(tokens);

    const dto = await useCase.execute('account-attacker', { token: 'owner-dev', serviceAlerts: false }, null);

    expect(dto).toBeNull();
    const raw = await tokens.findForAccount('account-owner', 'owner-dev');
    expect(raw?.serviceAlerts).toBe(true); // intacto
  });

  it('caso obligatorio 5 (per-device) — dos teléfonos de la MISMA cuenta: tocar UNO no afecta al otro', async () => {
    const tokens = new InMemoryPortalPushTokenRepository();
    await registerToken(tokens, 'account-family', 'phone-mom');
    await registerToken(tokens, 'account-family', 'phone-dad');
    const useCase = new UpdatePortalPushPreferences(tokens);

    await useCase.execute('account-family', { token: 'phone-dad', serviceAlerts: false }, null);

    const mom = await tokens.findForAccount('account-family', 'phone-mom');
    const dad = await tokens.findForAccount('account-family', 'phone-dad');
    expect(mom?.serviceAlerts).toBe(true);
    expect(dad?.serviceAlerts).toBe(false);
  });
});
