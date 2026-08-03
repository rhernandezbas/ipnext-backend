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

  /**
   * EPIC v3 fix wave W1 — los puertos de VISITA (wifi_0/2 y wifi_0/6, convención
   * del portal de visitas) JAMÁS pueden ser la banda "principal". Antes nunca
   * estaban enabled y el bug era latente; ahora el portal los enciende: con /1
   * apagado, /2 enabled pasaba a ser "Mi WiFi" (el GET mostraba el SSID de
   * visitas, el PUT principal ESCRIBÍA sobre la red de visitas y el disable de
   * visitas apagaba "la principal"). El main se elige SOLO entre {1,3,4} / {5,7,8}.
   */
  it('W1: /1 disabled + /2 (visita) enabled -> la principal es /1 (disabled), NUNCA el puerto de visita', () => {
    const bands = mapWifiPortsToBands([
      { port: 'wifi_0/1', ssid: 'Mi_WiFi', enabled: false },
      { port: 'wifi_0/2', ssid: 'Visitas', enabled: true },
    ]);

    expect(bands).toEqual([{ band: '2.4', port: 'wifi_0/1', ssid: 'Mi_WiFi', enabled: false }]);
  });

  it('W1: payload desordenado [/2 enabled, /1 enabled] -> la principal es /1 (no gana por orden de llegada)', () => {
    const bands = mapWifiPortsToBands([
      { port: 'wifi_0/2', ssid: 'Visitas', enabled: true },
      { port: 'wifi_0/1', ssid: 'Mi_WiFi', enabled: true },
    ]);

    expect(bands).toEqual([{ band: '2.4', port: 'wifi_0/1', ssid: 'Mi_WiFi', enabled: true }]);
  });

  it('W1: banda 5 — /5 disabled + /6 (visita) enabled -> la principal es /5, NUNCA /6', () => {
    const bands = mapWifiPortsToBands([
      { port: 'wifi_0/5', ssid: 'Mi_WiFi_5G', enabled: false },
      { port: 'wifi_0/6', ssid: 'Visitas_5G', enabled: true },
      { port: 'wifi_0/7', ssid: null, enabled: false },
      { port: 'wifi_0/8', ssid: null, enabled: false },
    ]);

    expect(bands).toEqual([{ band: '5', port: 'wifi_0/5', ssid: 'Mi_WiFi_5G', enabled: false }]);
  });

  it('W1: template degenerado con SOLO el puerto de visita en el rango -> sin banda principal (no se inventa una)', () => {
    const bands = mapWifiPortsToBands([
      { port: 'wifi_0/2', ssid: 'Visitas', enabled: true },
      { port: 'wifi_0/5', ssid: 'Casa_5G', enabled: true },
    ]);

    expect(bands).toEqual([{ band: '5', port: 'wifi_0/5', ssid: 'Casa_5G', enabled: true }]);
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
