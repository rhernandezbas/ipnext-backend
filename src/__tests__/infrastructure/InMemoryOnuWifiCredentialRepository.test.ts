/**
 * wifi-password-snapshot — cobertura directa del fake in-memory (molde
 * `InMemoryFiberAutoProvisionAttemptRepository`, mismo criterio de "unique
 * compuesto = clave del Map"). Cubre los casos TDD 3 (upsert por (sn,port),
 * CON revert-probe documentado en el reporte final) y 4 (upsert repetido
 * ACTUALIZA, no duplica, refresca updatedAt/updatedBy).
 */
import { InMemoryOnuWifiCredentialRepository } from '@infrastructure/adapters/in-memory/InMemoryOnuWifiCredentialRepository';

describe('InMemoryOnuWifiCredentialRepository', () => {
  it('upsert crea una fila; findManyBySn la devuelve', async () => {
    const repo = new InMemoryOnuWifiCredentialRepository();
    await repo.upsert({ sn: 'HWTC1', port: 'wifi_0/1', ssid: 'Casa', password: 'clave1234', updatedBy: 'portal' });

    const rows = await repo.findManyBySn('HWTC1');
    expect(rows).toEqual([
      expect.objectContaining({ sn: 'HWTC1', port: 'wifi_0/1', ssid: 'Casa', password: 'clave1234', updatedBy: 'portal' }),
    ]);
  });

  it('caso 3: upsert por (sn, port) — escribir la 2.4 NO pisa la password de la 5 de la MISMA sn', async () => {
    const repo = new InMemoryOnuWifiCredentialRepository();
    await repo.upsert({ sn: 'HWTC1', port: 'wifi_0/1', ssid: 'Casa', password: 'clave-24ghz', updatedBy: 'portal' });
    await repo.upsert({ sn: 'HWTC1', port: 'wifi_0/5', ssid: 'Casa_5G', password: 'clave-5ghz', updatedBy: 'portal' });

    const rows = await repo.findManyBySn('HWTC1');
    expect(rows).toHaveLength(2);
    const byPort = new Map(rows.map((r) => [r.port, r.password]));
    expect(byPort.get('wifi_0/1')).toBe('clave-24ghz');
    expect(byPort.get('wifi_0/5')).toBe('clave-5ghz');
  });

  it('caso 4: upsert DOS VECES la misma banda ACTUALIZA (no duplica) y refresca updatedAt/updatedBy', async () => {
    let now = 1_000;
    const repo = new InMemoryOnuWifiCredentialRepository(() => now);

    await repo.upsert({ sn: 'HWTC1', port: 'wifi_0/1', ssid: 'Casa', password: 'primera01', updatedBy: 'portal' });
    const first = (await repo.findManyBySn('HWTC1'))[0]!;

    now = 2_000;
    await repo.upsert({ sn: 'HWTC1', port: 'wifi_0/1', ssid: 'CasaNueva', password: 'segunda02', updatedBy: 'staff:u1' });
    const rows = await repo.findManyBySn('HWTC1');

    expect(rows).toHaveLength(1); // NO duplica.
    const second = rows[0]!;
    expect(second.ssid).toBe('CasaNueva');
    expect(second.password).toBe('segunda02');
    expect(second.updatedBy).toBe('staff:u1');
    expect(second.updatedAt).not.toBe(first.updatedAt); // refresca.
  });

  it('sn desconocida -> []', async () => {
    const repo = new InMemoryOnuWifiCredentialRepository();
    expect(await repo.findManyBySn('NUNCA-ESCRITA')).toEqual([]);
  });
});
