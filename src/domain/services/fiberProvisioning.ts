/**
 * smartolt-provision (K2) — conocimiento PURO del aprovisionamiento de ONUs
 * fibra Huawei vía SmartOLT. Sin I/O, sin reloj; el único no-determinismo
 * (dígitos de la clave WiFi) entra por un RNG inyectable.
 *
 * Reglas de negocio (decisiones del design K2):
 *  - Solo Huawei se auto-aprovisiona: SN con prefijo `HWTC` (case-insensitive).
 *  - SSIDs: `IPNEXT_<APELLIDO>_2.4` y `IPNEXT_<APELLIDO>_5`. Apellido = PRIMER
 *    token del `Client.name` GR ("APELLIDO(S) NOMBRE(S)"), MAYÚSCULAS sin
 *    acentos/diacríticos (Ñ→N) — misma heurística de split que
 *    `pppoeCredentials.ts` (K1), distinta normalización (upper vs lower).
 *  - Clave WiFi: número de contrato GR + dígitos random hasta 8 caracteres
 *    (mínimo WPA2). Contrato de 8+ chars queda tal cual.
 *  - Speed profiles SmartOLT derivados del NOMBRE del plan GR, best-effort:
 *    "300MB" → "300M" (simétrico), "50/25MB" → down "50M" / up "25M".
 *    No parseable → null (el authorize va SIN speed profiles y se ajusta a
 *    mano). Mapping configurable en el futuro (tabla plan→profile) — hoy la
 *    convención de nombres de la instancia IPNEXT es `<n>M` (verificado en
 *    get_speed_profiles), así que la derivación por nombre alcanza.
 */

/** Prefijo de serial Huawei — el único vendor auto-aprovisionable (K2). */
const HUAWEI_SN_PREFIX = 'HWTC';

/** Longitud mínima de la clave WiFi (WPA2). */
const WIFI_PASSWORD_MIN_LENGTH = 8;

export interface WifiSsids {
  ssid24: string;
  ssid5: string;
}

export interface SpeedProfileNames {
  download: string;
  upload: string;
}

/** ¿El SN es de una ONU Huawei? (prefijo HWTC, case-insensitive). */
export function isHuaweiSn(sn: string): boolean {
  return sn.toUpperCase().startsWith(HUAWEI_SN_PREFIX);
}

/** MAYÚSCULAS + sin diacríticos (NFD strip U+0300–U+036F, Ñ→N) + solo [A-Z0-9]. */
function normalizeApellido(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/** SSIDs de la ONU a partir del `Client.name` GR ("APELLIDO(S) NOMBRE(S)"). */
export function deriveWifiSsids(clientName: string): WifiSsids {
  const tokens = clientName.split(/\s+/).filter(t => t.length > 0);
  const apellido = normalizeApellido(tokens[0] ?? '');
  return {
    ssid24: `IPNEXT_${apellido}_2.4`,
    ssid5: `IPNEXT_${apellido}_5`,
  };
}

/**
 * Clave WiFi = número de contrato + dígitos random hasta 8 caracteres.
 * `rng` inyectable (() => [0,1), default Math.random) — determinístico en tests.
 */
export function deriveWifiPassword(
  grContratoId: string | null,
  rng: () => number = Math.random,
): string {
  let password = grContratoId ?? '';
  while (password.length < WIFI_PASSWORD_MIN_LENGTH) {
    password += String(Math.floor(rng() * 10));
  }
  return password;
}

/**
 * Nombres de speed profile SmartOLT derivados del plan GR, best-effort:
 * primer número = download, segundo (tras "/") = upload; sin segundo → simétrico.
 * Sin números → null (authorize sin profiles).
 */
export function deriveSpeedProfileNames(plan: string): SpeedProfileNames | null {
  const match = plan.match(/(\d+)\s*(?:\/\s*(\d+))?/);
  if (!match) return null;
  const download = `${match[1]}M`;
  const upload = `${match[2] ?? match[1]}M`;
  return { download, upload };
}
