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

/** Límite duro del estándar 802.11 para un SSID (bytes; acá es ASCII ⇒ chars). */
const SSID_MAX_BYTES = 32;
const SSID_PREFIX = 'IPNEXT_';
/** El sufijo MÁS LARGO ('_2.4') manda: ambas bandas usan el MISMO apellido truncado. */
const SSID_LONGEST_SUFFIX = '_2.4';
/** Fallback cuando el nombre no aporta ningún carácter usable (vacío / solo símbolos). */
const SSID_FALLBACK_TOKEN = 'CLIENTE';

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

/**
 * K3 (fiber-auto-watcher) — normalización CANÓNICA del serial de ONU:
 * UPPERCASE + sin whitespace. El match del watcher contra unconfigured_onus
 * y el registro de intentos usan SIEMPRE esta forma; un serial "sucio"
 * persistido tal cual jamás matchearía.
 */
export function normalizeOnuSerial(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

/** MAYÚSCULAS + sin diacríticos (NFD strip U+0300–U+036F, Ñ→N) + solo [A-Z0-9]. */
function normalizeApellido(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/**
 * SSIDs de la ONU a partir del `Client.name` GR ("APELLIDO(S) NOMBRE(S)").
 * Fix LOW-c: apellido vacío tras normalizar → fallback 'CLIENTE'; y el apellido
 * se trunca para que NINGÚN ssid supere los 32 bytes del estándar (el sufijo
 * más largo '_2.4' fija el corte, así ambas bandas comparten el apellido).
 */
export function deriveWifiSsids(clientName: string): WifiSsids {
  const tokens = clientName.split(/\s+/).filter(t => t.length > 0);
  const normalized = normalizeApellido(tokens[0] ?? '') || SSID_FALLBACK_TOKEN;
  const maxApellido = SSID_MAX_BYTES - SSID_PREFIX.length - SSID_LONGEST_SUFFIX.length;
  const apellido = normalized.slice(0, maxApellido);
  return {
    ssid24: `${SSID_PREFIX}${apellido}_2.4`,
    ssid5: `${SSID_PREFIX}${apellido}_5`,
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
 * Nombres de speed profile SmartOLT derivados del plan GR, best-effort.
 *
 * Fix H1: SOLO cuentan números con SUFIJO de unidad de velocidad (`MB` o `M`,
 * case-insensitive, con word boundary) — un número pelado puede ser un año
 * ("PLAN 2025 300MB"), un multiplicador ("PROMO 2X1 300MB") u otra unidad
 * ("1G"); tomar el primero mandaba un cliente gigabit a 1 mega EN SILENCIO.
 * Par down/up: "50/25MB" → 50M/25M; "300MB" → simétrico 300M/300M.
 *
 * Ante AMBIGÜEDAD (dos velocidades DISTINTAS con unidad) o CERO matches → null:
 * authorize SIN speed profile (ajuste manual) es mejor que un profile errado.
 * El caller lo hace visible (detail del paso authorize / params del plan).
 */
export function deriveSpeedProfileNames(plan: string): SpeedProfileNames | null {
  const matches = [...plan.matchAll(/(\d+)(?:\s*\/\s*(\d+))?\s*(?:MB|M)\b/gi)];
  if (matches.length === 0) return null;
  const pairs = matches.map(m => ({
    download: `${m[1]}M`,
    upload: `${m[2] ?? m[1]}M`,
  }));
  const first = pairs[0]!;
  const ambiguous = pairs.some(p => p.download !== first.download || p.upload !== first.upload);
  return ambiguous ? null : first;
}
