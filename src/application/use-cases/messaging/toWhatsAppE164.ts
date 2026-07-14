/**
 * messaging-bulk (F2, design §2.3) — reconstruye el E164 AR-móvil REAL
 * (`+549...`) a partir de un teléfono crudo de `Client.phone`, para el ENVÍO de
 * WhatsApp vía Twilio.
 *
 * Gotcha crítico (design §2.3): `normalizePhone` (matchActiveClient.ts) es LOSSY
 * — dropea el código de país, el "9" móvil y el "15". Sirve como CLAVE DE DE-DUP,
 * NUNCA para construir el destino real del envío. Esta función es la contraparte
 * que SÍ reconstruye el número completo enviable.
 *
 * ── fix wave (FIX-1): número equivocado ─────────────────────────────────────
 * La versión anterior:
 *  - NO quitaba el "15" móvil embebido entre código de área y abonado:
 *    `"011 15-2345-6789"` → `+549111523456789` (15 díg, MAL) en vez de
 *    `+5491123456789`.
 *  - dropeaba un "54" de un número local que casualmente empieza en 54
 *    (`"5412345678"`) creyéndolo country-code.
 *  - consumía el "9" inicial de un local como marcador móvil (`"9876543210"`).
 *
 * La reconstrucción correcta se ancla en el hecho del plan de numeración AR: el
 * NÚMERO NACIONAL SIGNIFICATIVO (NSN = código de área + abonado) es SIEMPRE de
 * 10 dígitos. El E164 móvil AR = `+54` + `9` + NSN(10). Con ese invariante se
 * distingue por LONGITUD un country-code real de dígitos que arrancan en 54/9, y
 * se ubica el "15" en el borde código-de-área/abonado. Si NO se puede
 * reconstruir un NSN de 10 dígitos con confianza → `null` (el caller lo trata
 * como teléfono inválido → `skipped.invalidPhone`), NUNCA un número equivocado.
 *
 * Pura, total — nunca throws.
 */
export function toWhatsAppE164(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;

  let digits = raw.replace(/\D/g, '');
  if (digits.length === 0) return null;

  // Prefijo de acceso internacional "00" (ej. "0054…") → descartar.
  if (digits.startsWith('00')) digits = digits.slice(2);

  // Country-code "54": se dropea SOLO cuando hay un NSN plausible detrás (longitud
  // ESTRICTAMENTE mayor a un NSN local pelado de 10 dígitos). Un local de 10
  // dígitos que apenas empieza en "54" NO es un country-code (falso positivo).
  if (digits.startsWith('54') && digits.length > 10) {
    digits = digits.slice(2);
    // Tras el country-code, un marcador móvil "9" opcional.
    if (digits.startsWith('9')) digits = digits.slice(1);
  }

  // Prefijo troncal "0" del discado nacional — uno o más ceros a la izquierda.
  while (digits.startsWith('0')) digits = digits.slice(1);

  const nsn = extractNsn(digits);
  if (nsn === null) return null;

  return `+549${nsn}`;
}

/**
 * Extrae el NSN de 10 dígitos (código de área + abonado) desde los dígitos ya
 * pelados de country-code / troncal. Devuelve `null` si no se puede reconstruir
 * un NSN de 10 dígitos con confianza.
 */
function extractNsn(digits: string): string | null {
  // NSN limpio.
  if (digits.length === 10) return digits;

  // "9" + NSN (marcador móvil sin country-code, dato raro pero visto).
  if (digits.length === 11 && digits.startsWith('9')) return digits.slice(1);

  // [área][15][abonado] — formato local con el "15" móvil embebido (12 díg).
  if (digits.length === 12) return stripLocal15(digits);

  // "9" + [área][15][abonado] (9 Y 15 redundantes, dato sucio).
  if (digits.length === 13 && digits.startsWith('9')) return stripLocal15(digits.slice(1));

  // Cualquier otra longitud → no es un NSN AR reconstruible con confianza.
  return null;
}

/**
 * Quita el "15" móvil que separa el código de área del abonado en un número
 * local de 12 dígitos (`[área][15][abonado]`, área+abonado = 10). El código de
 * área AR es de 2, 3 o 4 dígitos → el "15" queda en el índice 2, 3 o 4. El único
 * código de área de 2 dígitos es "11" (Gran Buenos Aires); los demás son de 3-4.
 * Si no hay un "15" en un borde de área válido → `null` (no es un local-con-15
 * reconocible, no arriesgar un número equivocado).
 */
function stripLocal15(nsnWith15: string): string | null {
  for (const areaLen of [2, 3, 4]) {
    if (nsnWith15.slice(areaLen, areaLen + 2) !== '15') continue;
    // Un área de 2 dígitos SOLO es válida si es "11" (evita cortar un "15" que
    // en realidad cae dentro de un área de 3-4 dígitos).
    if (areaLen === 2 && !nsnWith15.startsWith('11')) continue;
    const candidate = nsnWith15.slice(0, areaLen) + nsnWith15.slice(areaLen + 2);
    if (candidate.length === 10) return candidate;
  }
  return null;
}
