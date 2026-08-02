/**
 * wifi-self-service (F0) — mapeo de puertos WiFi crudos de la ONU a bandas de
 * dominio. proposal.md §Evidencia "Puertos": wifi_0/1..4 = 2.4GHz, wifi_0/5..8
 * = 5GHz — la lista de puertos sale de la plantilla "ONU type" de SmartOLT, NO
 * del hardware. La banda "principal" de cada rango es el primer puerto
 * Enabled, o el primero del rango (`/1`, `/5`) si ninguno está enabled.
 *
 * Función PURA — nada de I/O acá. El adapter SmartOLT mapea el shape crudo de
 * la API a `RawWifiPort[]` antes de llamar esta función (separación adapter
 * crudo / regla de negocio, mismo criterio que `toUnconfiguredOnu` vs el resto
 * de `SmartOltHttpGateway`).
 */
export interface RawWifiPort {
  /** 'wifi_0/1'..'wifi_0/8'. */
  port: string;
  ssid: string | null;
  enabled: boolean;
}

export interface WifiBandStatus {
  band: '2.4' | '5';
  port: string;
  ssid: string | null;
  enabled: boolean;
}

const BAND_RANGES: ReadonlyArray<{ band: '2.4' | '5'; ports: readonly number[] }> = [
  { band: '2.4', ports: [1, 2, 3, 4] },
  { band: '5', ports: [5, 6, 7, 8] },
];

function portNumber(port: string): number | null {
  const m = /^wifi_0\/(\d+)$/.exec(port);
  return m ? Number(m[1]) : null;
}

export function mapWifiPortsToBands(rawPorts: RawWifiPort[]): WifiBandStatus[] {
  const bands: WifiBandStatus[] = [];

  for (const range of BAND_RANGES) {
    const inRange = rawPorts.filter((p) => {
      const n = portNumber(p.port);
      return n !== null && (range.ports as readonly number[]).includes(n);
    });
    if (inRange.length === 0) continue;

    const firstPortNumber = range.ports[0];
    const main =
      inRange.find((p) => p.enabled) ??
      inRange.find((p) => portNumber(p.port) === firstPortNumber) ??
      inRange[0];

    bands.push({ band: range.band, port: main.port, ssid: main.ssid, enabled: main.enabled });
  }

  return bands;
}
