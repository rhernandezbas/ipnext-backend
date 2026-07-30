/**
 * fix/portal-balance-from-invoices — `normalizeGrCurrency`.
 *
 * Medido en prod: `Invoice.currency` guarda códigos de GR (`PES`/`DOL`), NO
 * ISO 4217. Sin normalizar, el DTO expone el código crudo y la app mobile lo
 * pasa a `Intl.NumberFormat`, que renderizaría literalmente "PES 127.561,28"
 * en vez de "$ 127.561,28". Ver docstring de `normalizeGrCurrency.ts` para la
 * decisión completa sobre `null`/vacío/código desconocido.
 */
import { normalizeGrCurrency } from '@domain/services/normalizeGrCurrency';

describe('normalizeGrCurrency — fix/portal-balance-from-invoices', () => {
  it('PES -> ARS', () => {
    expect(normalizeGrCurrency('PES')).toBe('ARS');
  });

  it('DOL -> USD', () => {
    expect(normalizeGrCurrency('DOL')).toBe('USD');
  });

  it('case-insensitive: pes/dol en minúscula también normalizan', () => {
    expect(normalizeGrCurrency('pes')).toBe('ARS');
    expect(normalizeGrCurrency('dol')).toBe('USD');
  });

  it('trim: espacios alrededor no rompen el match', () => {
    expect(normalizeGrCurrency('  PES  ')).toBe('ARS');
  });

  it('código desconocido (ni PES ni DOL) pasa TAL CUAL en mayúsculas — jamás asume ARS', () => {
    expect(normalizeGrCurrency('XYZ')).toBe('XYZ');
    expect(normalizeGrCurrency('eur')).toBe('EUR');
  });

  it('null -> null (nunca default a ARS: "no sabemos" no es "es pesos")', () => {
    expect(normalizeGrCurrency(null)).toBeNull();
  });

  it('undefined -> null', () => {
    expect(normalizeGrCurrency(undefined)).toBeNull();
  });

  it('string vacío (o solo espacios) -> null', () => {
    expect(normalizeGrCurrency('')).toBeNull();
    expect(normalizeGrCurrency('   ')).toBeNull();
  });
});
