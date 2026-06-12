import { fixedCodeFor } from '@domain/entities/networkSite';

/**
 * network-site-fixed-code (#51) — fixedCodeFor es el helper de dominio puro que
 * deriva el código fijo desde el siteNumber. Fuente única usada por ambos adapters.
 */
describe('networkSite domain — fixedCodeFor', () => {
  it('deriva el código fijo como "NODO {siteNumber}"', () => {
    expect(fixedCodeFor(1)).toBe('NODO 1');
    expect(fixedCodeFor(12)).toBe('NODO 12');
  });

  it('edge case: siteNumber 0', () => {
    expect(fixedCodeFor(0)).toBe('NODO 0');
  });

  it('funciona con números grandes', () => {
    expect(fixedCodeFor(9999)).toBe('NODO 9999');
  });

  it('es una función pura: misma entrada → misma salida', () => {
    expect(fixedCodeFor(7)).toBe(fixedCodeFor(7));
  });
});
