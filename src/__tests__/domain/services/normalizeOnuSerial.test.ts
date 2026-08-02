/**
 * wifi-self-service (F0) — normalizeOnuSerial: Prominense guarda el serial de la
 * ONU en HEX crudo (`48575443189C07AA`), SmartOLT lo expone en ASCII
 * (`HWTC189C07AA`) — ver proposal.md §Evidencia/Reglas 2a. Los primeros 8 chars
 * hex de un serial de 16 decodifican a 4 letras ASCII (el fabricante, "HWTC"
 * para Huawei); el resto del serial se conserva tal cual.
 */
import { normalizeOnuSerial } from '@domain/services/normalizeOnuSerial';

describe('normalizeOnuSerial', () => {
  it('decodifica hex de 16 chars a ASCII+resto (48575443189C07AA -> HWTC189C07AA)', () => {
    expect(normalizeOnuSerial('48575443189C07AA')).toBe('HWTC189C07AA');
  });

  it('un serial ya en formato ASCII pasa igual (idempotente)', () => {
    expect(normalizeOnuSerial('HWTC189C07AA')).toBe('HWTC189C07AA');
    // Ida y vuelta: normalizar el resultado normalizado da lo mismo.
    expect(normalizeOnuSerial(normalizeOnuSerial('48575443189C07AA'))).toBe('HWTC189C07AA');
  });

  it('tolera espacios y separadores ":" antes de decodificar', () => {
    expect(normalizeOnuSerial('48:57:54:43:18:9C:07:AA')).toBe('HWTC189C07AA');
    expect(normalizeOnuSerial('  4857 5443 189C07AA  ')).toBe('HWTC189C07AA');
  });

  it('uppercasea un ASCII en minúsculas', () => {
    expect(normalizeOnuSerial('hwtc189c07aa')).toBe('HWTC189C07AA');
  });

  it('basura (string corto, no-hex, vacío) pasa sin explotar (passthrough)', () => {
    expect(normalizeOnuSerial('')).toBe('');
    expect(normalizeOnuSerial('ABC')).toBe('ABC');
    expect(normalizeOnuSerial('not-a-serial-at-all')).toBe('NOT-A-SERIAL-AT-ALL');
    // 16 chars pero NO son todos hex -> no intenta decodificar, passthrough uppercase.
    expect(normalizeOnuSerial('ZZZZZZZZ189C07AA')).toBe('ZZZZZZZZ189C07AA');
  });

  it('16 hex chars cuyos primeros 8 NO decodifican a ASCII imprimible -> passthrough', () => {
    // 00000000 decodifica a 4 bytes NUL — no imprimibles, no debe "inventar" letras.
    expect(normalizeOnuSerial('00000000189C07AA')).toBe('00000000189C07AA');
  });

  it('no explota con input no-string (defensivo)', () => {
    // @ts-expect-error — input intencionalmente inválido para el test defensivo.
    expect(normalizeOnuSerial(null)).toBe('');
    // @ts-expect-error — input intencionalmente inválido para el test defensivo.
    expect(normalizeOnuSerial(undefined)).toBe('');
  });
});
