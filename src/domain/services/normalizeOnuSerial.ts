/**
 * wifi-self-service (F0) — normalización de seriales de ONU.
 *
 * Prominense guarda el serial en HEX crudo (`ContractInstalledItem.serialNumber`,
 * ej. `48575443189C07AA`); SmartOLT lo expone/espera en ASCII (`HWTC189C07AA`) —
 * proposal.md §Evidencia: "Prominense guarda hex, SmartOLT ASCII — decodificar
 * los primeros 8 hex chars a ASCII (31/41 matchean hoy)".
 *
 * Regla: si el serial (trim + sin espacios/':' + uppercase) tiene EXACTAMENTE 16
 * chars hex y los primeros 8 decodifican a 4 bytes ASCII imprimibles, se
 * devuelve ASCII(4) + resto(8) sin tocar. Cualquier otro caso (ya viene en
 * ASCII, es basura, está vacío) pasa TAL CUAL (uppercased) — nunca explota.
 */
export function normalizeOnuSerial(raw: string): string {
  if (typeof raw !== 'string') return '';

  const cleaned = raw.trim().replace(/[\s:]/g, '').toUpperCase();

  if (/^[0-9A-F]{16}$/.test(cleaned)) {
    const hexPrefix = cleaned.slice(0, 8);
    const rest = cleaned.slice(8);
    const bytePairs = hexPrefix.match(/.{2}/g) ?? [];
    const codes = bytePairs.map((pair) => Number.parseInt(pair, 16));
    // Imprimible ASCII (0x20-0x7E) — evita "decodificar" basura binaria en
    // letras fantasma (ver caso "00000000..." en el test).
    if (codes.every((c) => c >= 0x20 && c <= 0x7e)) {
      const ascii = codes.map((c) => String.fromCharCode(c)).join('');
      if (/^[A-Z0-9]{4}$/.test(ascii)) {
        return `${ascii}${rest}`;
      }
    }
  }

  return cleaned;
}
