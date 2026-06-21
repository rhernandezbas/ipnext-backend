/**
 * ouiVendor — tabla compacta de OUI → marca para CPEs/routers típicos de WISP.
 *
 * Mapea los primeros 3 octetos de una MAC (normalizados) a una marca conocida.
 * Se usa en InspectPppoeDevices para mostrar el fabricante del router del cliente
 * junto al MAC detectado en la ARP table de la antena airOS.
 *
 * Retorna `null` si el OUI no está en la tabla (no todos los fabricantes están incluidos —
 * solo los más comunes en instalaciones ISP).
 */

/**
 * Tabla de OUI → marca. Clave = 6 hex chars en minúsculas (sin separadores).
 * Los OUI se obtienen de la base pública IEEE MA-L.
 */
const OUI_TABLE: Record<string, string> = {
  // TP-Link (múltiples bloques)
  'c0c9e3': 'TP-Link',
  '50c7bf': 'TP-Link',
  'b0be76': 'TP-Link',
  'f4f26d': 'TP-Link',
  '1c3bca': 'TP-Link',
  '98dae3': 'TP-Link',
  'a0f3c1': 'TP-Link',
  '8cfab1': 'TP-Link',
  'e86f38': 'TP-Link',
  // MikroTik
  '4c5e0c': 'MikroTik',
  'd4ca6d': 'MikroTik',
  '2cc8e9': 'MikroTik',
  'b8690e': 'MikroTik',
  '485b39': 'MikroTik',
  // Ubiquiti / UBNT
  '788a20': 'Ubiquiti',
  '00272e': 'Ubiquiti',
  '0418d6': 'Ubiquiti',
  'dc9fdb': 'Ubiquiti',
  'e063da': 'Ubiquiti',
  '24a43c': 'Ubiquiti',
  'f09fc2': 'Ubiquiti',
  // Huawei
  '001e10': 'Huawei',
  '00259e': 'Huawei',
  '286ed4': 'Huawei',
  '4c1fcc': 'Huawei',
  'a08cf8': 'Huawei',
  // ZTE
  '002266': 'ZTE',
  '08e84f': 'ZTE',
  'f8f081': 'ZTE',
  'ec233d': 'ZTE',
  // D-Link
  '00050a': 'D-Link',
  '001195': 'D-Link',
  '14d64d': 'D-Link',
  '1c7ee5': 'D-Link',
  // Tenda
  'c83a35': 'Tenda',
  '1c1b0d': 'Tenda',
  'a48640': 'Tenda',
};

/**
 * Normaliza una MAC a 12 hex chars en minúsculas (sin separadores).
 * Soporta formatos: `AA:BB:CC:DD:EE:FF`, `AA-BB-CC-DD-EE-FF`, `AABBCCDDEEFF`.
 */
function normalizeMac(mac: string): string {
  return mac.toLowerCase().replace(/[:\-\s]/g, '');
}

/**
 * Retorna la marca del fabricante de la MAC basándose en los primeros 3 octetos (OUI),
 * o `null` si el OUI no está en la tabla.
 *
 * @param mac — MAC en cualquier formato estándar (con/sin separadores, mayúsculas/minúsculas).
 */
export function vendorFromMac(mac: string): string | null {
  if (!mac) return null;
  const normalized = normalizeMac(mac);
  if (normalized.length < 6) return null;
  const oui = normalized.slice(0, 6);
  return OUI_TABLE[oui] ?? null;
}
