/**
 * messaging-bulk (F2, T2.5) — toWhatsAppE164: reconstruye el E164 AR-móvil real
 * (+549...) para el ENVÍO de WhatsApp. Distinto de `normalizePhone` (lossy, solo
 * sirve de clave de de-dup — matchActiveClient.ts) — design §2.3.
 *
 * NOTA: el shape exacto (+549 vs +54) es best-effort hasta el gate de verificación
 * EN VIVO (batch 9). Si el test-send real muestra otro prefijo, este test se ajusta
 * ahí, no antes.
 */
import { toWhatsAppE164 } from '@application/use-cases/messaging/toWhatsAppE164';

describe('toWhatsAppE164', () => {
  it('número local sin código de país ni 9 móvil → reconstruye +549...', () => {
    expect(toWhatsAppE164('3364123456')).toBe('+5493364123456');
  });

  it('ya en formato E164 con 9 móvil y separadores → idempotente (mismo resultado)', () => {
    expect(toWhatsAppE164('+54 9 3364 12-3456')).toBe('+5493364123456');
  });

  it('E164 sin el 9 móvil → agrega el 9', () => {
    expect(toWhatsAppE164('+54 3364 123456')).toBe('+5493364123456');
  });

  it('basura ("123", menos de 6 dígitos significativos) → null', () => {
    expect(toWhatsAppE164('123')).toBeNull();
  });

  it('null → null', () => {
    expect(toWhatsAppE164(null)).toBeNull();
  });

  it('string vacío → null', () => {
    expect(toWhatsAppE164('')).toBeNull();
  });

  // ── FIX-1: "15" móvil embebido entre código de área y abonado ──────────────
  it('FIX-1: "011 15-2345-6789" (troncal 0 + área 11 + 15 + abonado) → quita el 15 → +5491123456789', () => {
    // BUG previo: producía +549111523456789 (15 díg, con el 15 pegado) → número equivocado.
    expect(toWhatsAppE164('011 15-2345-6789')).toBe('+5491123456789');
  });

  it('FIX-1: "11 15 2345 6789" (sin troncal) → quita el 15 → +5491123456789', () => {
    expect(toWhatsAppE164('11 15 2345 6789')).toBe('+5491123456789');
  });

  it('FIX-1: "03364 15-123456" (área de 4 dígitos + 15 + abonado) → quita el 15 → +5493364123456', () => {
    expect(toWhatsAppE164('03364 15-123456')).toBe('+5493364123456');
  });

  it('FIX-1: ya en +5491123456789 (con 9, sin 15) → idempotente', () => {
    expect(toWhatsAppE164('+5491123456789')).toBe('+5491123456789');
  });

  it('FIX-1: E164 con 9 sin 15 ("+54 9 11 2345 6789") → +5491123456789', () => {
    expect(toWhatsAppE164('+54 9 11 2345 6789')).toBe('+5491123456789');
  });

  it('FIX-1: local sin 9 ("11 2345 6789", NSN de 10 dígitos) → +5491123456789', () => {
    expect(toWhatsAppE164('11 2345 6789')).toBe('+5491123456789');
  });

  // ── FIX-1: falsos positivos de country-code/marcador ───────────────────────
  it('FIX-1 (falso positivo 54): local de 10 dígitos que empieza en 54 → NO dropea el "54" como country-code', () => {
    // BUG previo: dropeaba el 54 → +54912345678 (número equivocado). Correcto: NSN completo de 10.
    expect(toWhatsAppE164('5412345678')).toBe('+5495412345678');
  });

  it('FIX-1 (falso positivo 9): local de 10 dígitos que empieza en 9 → NO consume el "9" como marcador', () => {
    // BUG previo: consumía el 9 inicial → +549876543210 (número equivocado).
    expect(toWhatsAppE164('9876543210')).toBe('+5499876543210');
  });

  // ── FIX-1: números que no se pueden normalizar con confianza → null ────────
  it('FIX-1: 12 dígitos sin "15" en un borde de área válido → null (no arriesga un número equivocado)', () => {
    expect(toWhatsAppE164('111111111111')).toBeNull();
  });

  it('FIX-1: número corto (9 dígitos, NSN incompleto) → null', () => {
    expect(toWhatsAppE164('112345678')).toBeNull();
  });
});
