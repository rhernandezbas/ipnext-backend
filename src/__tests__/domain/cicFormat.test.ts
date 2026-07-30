/**
 * gigared-tv-cic-reuse (T1.2) — validez de formato de un CIC del pool.
 *
 * WHY: el 2026-07-30 NINGUNA alta de TV funcionaba. El pool tenía un único CIC "limpio"
 * (sin internal_id) y su valor era `'00065470 4'` — con un byte 0x20 (ESPACIO) en la
 * posición 8, corrupto en el CRM del partner. El filtro anti-veneno validaba PRESENCIA
 * del cic pero no su FORMATO, así que ese CIC pasaba como candidato; y con un solo
 * candidato el pick "aleatorio" es determinístico, así que se elegía SIEMPRE.
 * El partner respondía 403 cic-ownership-error → el adapter lo mapea a NotFound →
 * 404 "Gigared account not found" al operador, en cada alta, para todos los clientes.
 *
 * DECISIÓN DE DISEÑO (spec CIC-1): se valida la CLASE DE CARACTERES, no la LONGITUD.
 * Todos los CICs observados tienen 10 dígitos, pero fijar /^\d{10}$/ haría que un CIC
 * de otra longitud emitido por el partner bloquee el 100% de las altas — exactamente el
 * fallo que este change viene a arreglar. Se rechaza el modo de falla OBSERVADO (un
 * carácter no numérico), no una suposición sobre el largo.
 */
import { isValidCicFormat } from '@domain/gigared/cicFormat';

describe('gigared-tv-cic-reuse T1.2 — isValidCicFormat', () => {
  it('CICs reales del pool de producción → válidos', () => {
    for (const cic of [
      '0006677401',
      '0006168430',
      '0006832019',
      '0006107090',
      '0006411239',
      '0006450297',
      '0006166000',
      '0006871501',
      '0006282445',
    ]) {
      expect(isValidCicFormat(cic)).toBe(true);
    }
  });

  it('EL BUG REAL: el CIC con un ESPACIO embebido → INVÁLIDO', () => {
    const roto = '00065470 4';
    // Documentado explícitamente: el carácter de la posición 8 es 0x20, no un dígito.
    expect(roto).toHaveLength(10);
    expect(roto.charCodeAt(8)).toBe(0x20);

    expect(isValidCicFormat(roto)).toBe(false);
  });

  it('vacío / null / undefined → inválido', () => {
    expect(isValidCicFormat('')).toBe(false);
    expect(isValidCicFormat(null)).toBe(false);
    expect(isValidCicFormat(undefined)).toBe(false);
  });

  it('cualquier carácter fuera de [0-9] → inválido', () => {
    expect(isValidCicFormat('abc')).toBe(false);
    expect(isValidCicFormat('00066774O1')).toBe(false); // letra O en vez de cero
    expect(isValidCicFormat('0006677-01')).toBe(false);
    expect(isValidCicFormat('0006677401\n')).toBe(false);
    expect(isValidCicFormat(' 0006677401')).toBe(false);
    expect(isValidCicFormat('0006677401 ')).toBe(false);
    expect(isValidCicFormat('+006677401')).toBe(false);
  });

  it('NO se valida la longitud — un CIC numérico de otro largo sigue siendo válido', () => {
    // Guard contra la regresión que un /^\d{10}$/ introduciría: si el partner emitiera
    // CICs de otro largo, la versión estricta bloquearía TODAS las altas.
    expect(isValidCicFormat('12345678901')).toBe(true);
    expect(isValidCicFormat('123456')).toBe(true);
  });
});
