/**
 * Capa 2 — infer the device class from a checklist question label by keyword.
 * Soft-fail: anything unrecognized → 'OTROS' (never throws). Used to tag OCR
 * extractions and to decide which photos carry SN/MAC worth extracting.
 *
 * Return type is `string` (not a closed union) because the valid set is
 * now dynamic (DeviceTypeCatalog). The returned values happen to match the
 * 5 base catalog names by convention.
 */
export function classifyDeviceType(label: string): string {
  const s = (label || '').toUpperCase();
  if (/\bONU\b|GPON/.test(s)) return 'ONU';
  if (/ROUTER/.test(s)) return 'ROUTER';
  if (/ANTENA/.test(s)) return 'ANTENA';
  if (/REPETIDOR/.test(s)) return 'REPETIDOR';
  return 'OTROS';
}

/** True when the question asks for a SN/MAC photo of a recognizable device. */
export function isSnMacDevicePhoto(label: string): boolean {
  const s = (label || '').toUpperCase();
  return /\bMAC\b|\bSN\b|SERIAL/.test(s) && classifyDeviceType(label) !== 'OTROS';
}
