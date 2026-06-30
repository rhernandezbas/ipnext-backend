import { parseIntervalMs } from '@infrastructure/parseIntervalMs';

/**
 * parseIntervalMs — helper puro de parseo de un intervalo (ms) desde una env var
 * opcional, con default y mínimo de seguridad. No toca process.env: recibe el raw.
 *
 * Reglas (definidas en la tarea):
 * - ausente / '' / no-numérico / NaN / <= 0  -> default
 * - valor válido por debajo del mínimo        -> min (clamp al piso de seguridad)
 * - valor válido >= min                       -> el valor
 */
describe('parseIntervalMs', () => {
  const opts = { default: 60_000, min: 15_000 };

  it('env ausente (undefined) -> default', () => {
    expect(parseIntervalMs(undefined, opts)).toBe(60_000);
  });

  it("numérico válido >= min -> ese valor ('120000' -> 120000)", () => {
    expect(parseIntervalMs('120000', opts)).toBe(120_000);
  });

  it("no-numérico ('abc') -> default", () => {
    expect(parseIntervalMs('abc', opts)).toBe(60_000);
  });

  it("string vacío ('') -> default", () => {
    expect(parseIntervalMs('', opts)).toBe(60_000);
  });

  it("por debajo del mínimo ('5000' < 15000) -> min (clamp al piso de seguridad)", () => {
    expect(parseIntervalMs('5000', opts)).toBe(15_000);
  });

  it("exactamente el mínimo ('15000') -> 15000", () => {
    expect(parseIntervalMs('15000', opts)).toBe(15_000);
  });

  it("negativo ('-1000') -> default", () => {
    expect(parseIntervalMs('-1000', opts)).toBe(60_000);
  });

  it("cero ('0') -> default", () => {
    expect(parseIntervalMs('0', opts)).toBe(60_000);
  });

  // raison d'être del helper: usar Number (no parseInt) para RECHAZAR basura mixta.
  // Si alguien refactoriza a parseInt, '120000abc' devolvería 120000 y este test FALLA.
  it("numérico con sufijo basura ('120000abc') -> default (Number, no parseInt)", () => {
    expect(parseIntervalMs('120000abc', opts)).toBe(60_000);
  });

  it("float ('60000.5') -> truncado a entero (60000)", () => {
    expect(parseIntervalMs('60000.5', opts)).toBe(60_000);
  });

  // Techo: evita el footgun de Node (delay > TIMEOUT_MAX -> setInterval dispara cada 1ms).
  it('por encima del máximo -> clampa al techo', () => {
    expect(parseIntervalMs('200000000', { default: 60_000, min: 15_000, max: 86_400_000 })).toBe(86_400_000);
  });

  it('sin max explícito, valor astronómico -> clampa a TIMEOUT_MAX de Node (2147483647)', () => {
    expect(parseIntervalMs('9999999999', opts)).toBe(2_147_483_647);
  });

  // El default se clampea contra el min (invariante defendida, no asumida).
  it("inválido con default < min -> min (default clampeado al piso)", () => {
    expect(parseIntervalMs('abc', { default: 10_000, min: 15_000 })).toBe(15_000);
  });
});
