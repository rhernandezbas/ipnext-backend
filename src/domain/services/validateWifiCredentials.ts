import { WifiValidationError } from '@domain/errors/wifi';

/**
 * wifi-self-service (F0) — validación de forma para SSID/password de WiFi.
 * Reglas del proposal: ssid 1..32 chars (límite del hardware WiFi estándar,
 * 32 bytes) sin chars de control; password 8..63 (rango válido de una WPA2
 * passphrase — 63 es el máximo del estándar, no un número arbitrario).
 * Reusado por el PUT del portal Y el PUT admin (misma regla, un solo lugar).
 */
const MAX_SSID_LEN = 32;
const MIN_PASSWORD_LEN = 8;
const MAX_PASSWORD_LEN = 63;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\x00-\x1F\x7F]/;

export function validateWifiSsid(ssid: string): void {
  if (typeof ssid !== 'string' || ssid.length < 1 || ssid.length > MAX_SSID_LEN) {
    throw new WifiValidationError(`ssid debe tener entre 1 y ${MAX_SSID_LEN} caracteres`);
  }
  if (CONTROL_CHARS_RE.test(ssid)) {
    throw new WifiValidationError('ssid no puede contener caracteres de control');
  }
}

export function validateWifiPassword(password: string): void {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LEN || password.length > MAX_PASSWORD_LEN) {
    throw new WifiValidationError(`password debe tener entre ${MIN_PASSWORD_LEN} y ${MAX_PASSWORD_LEN} caracteres (WPA2)`);
  }
  if (CONTROL_CHARS_RE.test(password)) {
    throw new WifiValidationError('password no puede contener caracteres de control');
  }
}

/** Puerto WiFi SmartOLT válido: 'wifi_0/1'..'wifi_0/8' (ver mapWifiPortsToBands). */
const WIFI_PORT_RE = /^wifi_0\/[1-8]$/;

export function validateWifiPort(port: string): void {
  if (typeof port !== 'string' || !WIFI_PORT_RE.test(port)) {
    throw new WifiValidationError("port inválido — debe ser 'wifi_0/1'..'wifi_0/8'");
  }
}
