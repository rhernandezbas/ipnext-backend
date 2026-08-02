/**
 * wifi-self-service (F0) — mapWifiPortsToBands: mapeo de puertos WiFi crudos de
 * SmartOLT a bandas de dominio. proposal.md §Evidencia "Puertos": wifi_0/1..4 =
 * 2.4GHz, wifi_0/5..8 = 5GHz; la banda "principal" de cada rango es el primer
 * puerto Enabled (o el /1 y /5 si ninguno está enabled). 0 puertos = sin WiFi
 * (bridges, ~1.830 según el proposal).
 */
import { mapWifiPortsToBands } from '@domain/services/mapWifiPortsToBands';

describe('mapWifiPortsToBands', () => {
  it('8 puertos (4+4) -> 2 bandas, principal = el primero enabled de cada rango', () => {
    const bands = mapWifiPortsToBands([
      { port: 'wifi_0/1', ssid: 'Familia_Perez', enabled: true },
      { port: 'wifi_0/2', ssid: null, enabled: false },
      { port: 'wifi_0/3', ssid: null, enabled: false },
      { port: 'wifi_0/4', ssid: null, enabled: false },
      { port: 'wifi_0/5', ssid: 'Familia_Perez_5G', enabled: true },
      { port: 'wifi_0/6', ssid: null, enabled: false },
      { port: 'wifi_0/7', ssid: null, enabled: false },
      { port: 'wifi_0/8', ssid: null, enabled: false },
    ]);

    expect(bands).toEqual([
      { band: '2.4', port: 'wifi_0/1', ssid: 'Familia_Perez', enabled: true },
      { band: '5', port: 'wifi_0/5', ssid: 'Familia_Perez_5G', enabled: true },
    ]);
  });

  it('4 puertos (solo el rango 2.4) -> solo banda 2.4', () => {
    const bands = mapWifiPortsToBands([
      { port: 'wifi_0/1', ssid: 'Casa', enabled: true },
      { port: 'wifi_0/2', ssid: null, enabled: false },
      { port: 'wifi_0/3', ssid: null, enabled: false },
      { port: 'wifi_0/4', ssid: null, enabled: false },
    ]);

    expect(bands).toEqual([{ band: '2.4', port: 'wifi_0/1', ssid: 'Casa', enabled: true }]);
  });

  it('0 puertos -> sin WiFi (bridge)', () => {
    expect(mapWifiPortsToBands([])).toEqual([]);
  });

  it('el puerto principal es el primero ENABLED, no necesariamente el /1 o el /5', () => {
    const bands = mapWifiPortsToBands([
      { port: 'wifi_0/1', ssid: null, enabled: false },
      { port: 'wifi_0/2', ssid: null, enabled: false },
      { port: 'wifi_0/3', ssid: 'RedReal', enabled: true },
      { port: 'wifi_0/4', ssid: null, enabled: false },
      { port: 'wifi_0/5', ssid: null, enabled: false },
      { port: 'wifi_0/6', ssid: null, enabled: false },
      { port: 'wifi_0/7', ssid: 'RedReal_5G', enabled: true },
      { port: 'wifi_0/8', ssid: null, enabled: false },
    ]);

    expect(bands).toEqual([
      { band: '2.4', port: 'wifi_0/3', ssid: 'RedReal', enabled: true },
      { band: '5', port: 'wifi_0/7', ssid: 'RedReal_5G', enabled: true },
    ]);
  });

  it('rango presente pero NINGÚN puerto enabled -> cae al primero del rango (/1 o /5), enabled false', () => {
    const bands = mapWifiPortsToBands([
      { port: 'wifi_0/1', ssid: null, enabled: false },
      { port: 'wifi_0/2', ssid: null, enabled: false },
      { port: 'wifi_0/5', ssid: null, enabled: false },
      { port: 'wifi_0/6', ssid: null, enabled: false },
    ]);

    expect(bands).toEqual([
      { band: '2.4', port: 'wifi_0/1', ssid: null, enabled: false },
      { band: '5', port: 'wifi_0/5', ssid: null, enabled: false },
    ]);
  });
});
