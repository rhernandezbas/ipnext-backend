import { GetPortalPushPreferences } from '@application/use-cases/portal/GetPortalPushPreferences';
import { UpdatePortalPushPreferences } from '@application/use-cases/portal/UpdatePortalPushPreferences';
import { InMemoryPortalPushPreferenceRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalPushPreferenceRepository';

describe('GetPortalPushPreferences', () => {
  it('caso obligatorio 3 — crea el registro con defaults serviceAlerts=true, promos=false (los DOS valores)', async () => {
    const prefs = new InMemoryPortalPushPreferenceRepository();
    const useCase = new GetPortalPushPreferences(prefs);

    const dto = await useCase.execute('account-1');

    expect(dto.serviceAlerts).toBe(true);
    expect(dto.promos).toBe(false);
  });

  it('llamadas repetidas devuelven el MISMO registro (no crea uno nuevo por request)', async () => {
    const prefs = new InMemoryPortalPushPreferenceRepository();
    const useCase = new GetPortalPushPreferences(prefs);

    await useCase.execute('account-1');
    const updated = await prefs.update('account-1', { serviceAlerts: false });
    expect(updated.serviceAlerts).toBe(false);

    const dto = await useCase.execute('account-1');
    expect(dto.serviceAlerts).toBe(false);
  });
});

describe('UpdatePortalPushPreferences', () => {
  it('caso obligatorio 4 — promos false->true estampa promosOptInAt y promosOptInAppVersion', async () => {
    const prefs = new InMemoryPortalPushPreferenceRepository();
    const fixedNow = new Date('2026-08-01T12:00:00.000Z');
    const useCase = new UpdatePortalPushPreferences(prefs, () => fixedNow);

    const dto = await useCase.execute('account-1', { promos: true }, '1.4.0');

    expect(dto.promos).toBe(true);
    const raw = await prefs.getOrCreate('account-1');
    expect(raw.promosOptInAt).toBe(fixedNow.toISOString());
    expect(raw.promosOptInAppVersion).toBe('1.4.0');
  });

  it('promos false->true sin header X-App-Version estampa promosOptInAppVersion=null (no bloquea el opt-in)', async () => {
    const prefs = new InMemoryPortalPushPreferenceRepository();
    const useCase = new UpdatePortalPushPreferences(prefs);

    await useCase.execute('account-1', { promos: true }, null);

    const raw = await prefs.getOrCreate('account-1');
    expect(raw.promosOptInAppVersion).toBeNull();
    expect(raw.promosOptInAt).not.toBeNull();
  });

  it('caso obligatorio 4 — promos true->false CONSERVA el estampado histórico (no lo borra)', async () => {
    const prefs = new InMemoryPortalPushPreferenceRepository();
    const optInAt = new Date('2026-07-01T09:00:00.000Z');
    const useCase = new UpdatePortalPushPreferences(prefs, () => optInAt);
    await useCase.execute('account-1', { promos: true }, '1.4.0');

    const laterUseCase = new UpdatePortalPushPreferences(prefs, () => new Date('2026-08-01T00:00:00.000Z'));
    const dto = await laterUseCase.execute('account-1', { promos: false }, '1.5.0');

    expect(dto.promos).toBe(false);
    const raw = await prefs.getOrCreate('account-1');
    // El estampado ORIGINAL sigue ahí, sin pisar con el "1.5.0"/fecha del apagado.
    expect(raw.promosOptInAt).toBe(optInAt.toISOString());
    expect(raw.promosOptInAppVersion).toBe('1.4.0');
  });

  it('promos true->true (no-op real) NO re-estampa el opt-in original', async () => {
    const prefs = new InMemoryPortalPushPreferenceRepository();
    const optInAt = new Date('2026-07-01T09:00:00.000Z');
    const useCase = new UpdatePortalPushPreferences(prefs, () => optInAt);
    await useCase.execute('account-1', { promos: true }, '1.4.0');

    const laterUseCase = new UpdatePortalPushPreferences(prefs, () => new Date('2026-08-01T00:00:00.000Z'));
    await laterUseCase.execute('account-1', { promos: true }, '1.5.0');

    const raw = await prefs.getOrCreate('account-1');
    expect(raw.promosOptInAt).toBe(optInAt.toISOString());
    expect(raw.promosOptInAppVersion).toBe('1.4.0');
  });

  it('actualizar solo serviceAlerts no toca promos ni su histórico de opt-in', async () => {
    const prefs = new InMemoryPortalPushPreferenceRepository();
    const useCase = new UpdatePortalPushPreferences(prefs);

    const dto = await useCase.execute('account-1', { serviceAlerts: false }, null);

    expect(dto.serviceAlerts).toBe(false);
    expect(dto.promos).toBe(false);
  });
});
