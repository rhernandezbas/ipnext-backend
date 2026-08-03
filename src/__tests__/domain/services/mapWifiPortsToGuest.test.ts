/**
 * EPIC v3 (wifi de visitas) — `mapWifiPortsToGuest`: derivación DINÁMICA de la
 * disponibilidad del puerto de visita por banda a partir de los puertos que el
 * ONU type expone (evidencia EN VIVO 2026-08-03, ONU HWTCA92F96B1: el template
 * puede traer SOLO wifi_0/1..2 — sin NINGÚN puerto 5GHz). Convención (skill
 * smartolt-ipnext + mapWifiPortsToBands): visita 2.4 = wifi_0/2, visita 5 =
 * wifi_0/6. Extensión ADITIVA — el shape de `mapWifiPortsToBands` NO cambia.
 */
import { mapWifiPortsToGuest, RawWifiPort } from '@domain/services/mapWifiPortsToBands';

/** Template completo de 8 puertos (payload real 2026-08-02, ONU HWTC189C07AA). */
const EIGHT_PORTS: RawWifiPort[] = [
  { port: 'wifi_0/1', ssid: 'Familia_Perez', enabled: true },
  { port: 'wifi_0/2', ssid: null, enabled: false },
  { port: 'wifi_0/3', ssid: null, enabled: false },
  { port: 'wifi_0/4', ssid: null, enabled: false },
  { port: 'wifi_0/5', ssid: 'Familia_Perez_5G', enabled: true },
  { port: 'wifi_0/6', ssid: null, enabled: false },
  { port: 'wifi_0/7', ssid: null, enabled: false },
  { port: 'wifi_0/8', ssid: null, enabled: false },
];

/** Template REAL de la ONU HWTCA92F96B1 (2026-08-03): SOLO wifi_0/1 y wifi_0/2 — sin 5GHz. */
const TWO_PORTS_24_ONLY: RawWifiPort[] = [
  { port: 'wifi_0/1', ssid: 'Luis', enabled: true },
  { port: 'wifi_0/2', ssid: null, enabled: false },
];

describe('mapWifiPortsToGuest', () => {
  it('template de 8 puertos -> ambas bandas con visita disponible (wifi_0/2 y wifi_0/6)', () => {
    expect(mapWifiPortsToGuest(EIGHT_PORTS)).toEqual([
      { band: '2.4', port: 'wifi_0/2', available: true, ssid: null, enabled: false },
      { band: '5', port: 'wifi_0/6', available: true, ssid: null, enabled: false },
    ]);
  });

  it('template real de 2 puertos (HWTCA92F96B1) -> visita 2.4 disponible, 5 NO disponible', () => {
    expect(mapWifiPortsToGuest(TWO_PORTS_24_ONLY)).toEqual([
      { band: '2.4', port: 'wifi_0/2', available: true, ssid: null, enabled: false },
      { band: '5', port: 'wifi_0/6', available: false, ssid: null, enabled: false },
    ]);
  });

  it('puerto de visita configurado y prendido -> refleja ssid + enabled', () => {
    const ports: RawWifiPort[] = [
      { port: 'wifi_0/1', ssid: 'Casa', enabled: true },
      { port: 'wifi_0/2', ssid: 'Visitas_Casa', enabled: true },
    ];
    const guest = mapWifiPortsToGuest(ports);
    expect(guest.find((g) => g.band === '2.4')).toEqual({
      band: '2.4',
      port: 'wifi_0/2',
      available: true,
      ssid: 'Visitas_Casa',
      enabled: true,
    });
  });

  it('sin puertos -> SIEMPRE las dos bandas listadas, ambas no disponibles', () => {
    expect(mapWifiPortsToGuest([])).toEqual([
      { band: '2.4', port: 'wifi_0/2', available: false, ssid: null, enabled: false },
      { band: '5', port: 'wifi_0/6', available: false, ssid: null, enabled: false },
    ]);
  });

  it('el principal presente NO hace disponible a la visita (wifi_0/1 solo -> 2.4 no disponible)', () => {
    const guest = mapWifiPortsToGuest([{ port: 'wifi_0/1', ssid: 'Casa', enabled: true }]);
    expect(guest.find((g) => g.band === '2.4')!.available).toBe(false);
  });
});
