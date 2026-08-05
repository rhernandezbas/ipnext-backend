/**
 * wifi-guest-pending — cobertura directa del fake in-memory del intent de
 * cambio de la red de visitas (molde `InMemoryOnuWifiCredentialRepository.test.ts`).
 * Clave del Map = sn (unique real de la tabla `WifiGuestIntent`): UN intent por
 * ONU a la vez — `replace` PISA el anterior (retry sobre unconfirmed) y resetea
 * `retriedAt` a null.
 */
import { InMemoryWifiGuestIntentRepository } from '@infrastructure/adapters/in-memory/InMemoryWifiGuestIntentRepository';

describe('InMemoryWifiGuestIntentRepository', () => {
  it('findBySn sin intent -> null', async () => {
    const repo = new InMemoryWifiGuestIntentRepository();
    expect(await repo.findBySn('HWTC1')).toBeNull();
  });

  it('replace crea el intent (retriedAt null) y findBySn lo devuelve', async () => {
    const repo = new InMemoryWifiGuestIntentRepository();
    const created = await repo.replace({ sn: 'HWTC1', contractId: 'c1', action: 'deleting', port: 'wifi_0/2', since: '2026-08-05T10:00:00.000Z' });

    const found = await repo.findBySn('HWTC1');
    expect(found).toEqual({
      id: created.id,
      sn: 'HWTC1',
      contractId: 'c1',
      action: 'deleting',
      port: 'wifi_0/2',
      since: '2026-08-05T10:00:00.000Z',
      retriedAt: null,
    });
  });

  it('replace sobre una sn con intent PISA el anterior (no duplica) y resetea retriedAt', async () => {
    const repo = new InMemoryWifiGuestIntentRepository();
    const first = await repo.replace({ sn: 'HWTC1', contractId: 'c1', action: 'deleting', port: 'wifi_0/2', since: '2026-08-05T10:00:00.000Z' });
    await repo.markRetried(first.id, '2026-08-05T10:04:00.000Z');

    await repo.replace({ sn: 'HWTC1', contractId: 'c1', action: 'creating', port: 'wifi_0/6', since: '2026-08-05T11:00:00.000Z' });

    expect(repo.all()).toHaveLength(1);
    const found = await repo.findBySn('HWTC1');
    expect(found).toMatchObject({ action: 'creating', port: 'wifi_0/6', since: '2026-08-05T11:00:00.000Z', retriedAt: null });
  });

  it('markRetried sella retriedAt del intent por id', async () => {
    const repo = new InMemoryWifiGuestIntentRepository();
    const created = await repo.replace({ sn: 'HWTC1', contractId: 'c1', action: 'deleting', port: 'wifi_0/2', since: '2026-08-05T10:00:00.000Z' });

    await repo.markRetried(created.id, '2026-08-05T10:04:00.000Z');

    expect((await repo.findBySn('HWTC1'))!.retriedAt).toBe('2026-08-05T10:04:00.000Z');
  });

  it('deleteBySn borra SOLO esa sn — otra sn no se ve afectada', async () => {
    const repo = new InMemoryWifiGuestIntentRepository();
    await repo.replace({ sn: 'HWTC1', contractId: 'c1', action: 'deleting', port: 'wifi_0/2', since: '2026-08-05T10:00:00.000Z' });
    await repo.replace({ sn: 'HWTC2', contractId: 'c1', action: 'creating', port: 'wifi_0/2', since: '2026-08-05T10:00:00.000Z' });

    await repo.deleteBySn('HWTC1');

    expect(await repo.findBySn('HWTC1')).toBeNull();
    expect(await repo.findBySn('HWTC2')).not.toBeNull();
  });

  it('deleteBySn de una sn inexistente no tira', async () => {
    const repo = new InMemoryWifiGuestIntentRepository();
    await expect(repo.deleteBySn('NUNCA')).resolves.toBeUndefined();
  });
});
