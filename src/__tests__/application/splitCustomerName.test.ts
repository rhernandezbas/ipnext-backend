/**
 * B8 (D1, OPCIONAL hardening) — splitCustomerName: helper puro que separa el `Client.name`
 * (un solo campo, sin firstName/lastName propios) en { firstName, lastName } con la convención
 * APELLIDO-primero (el PRIMER token es el apellido, el resto es el nombre).
 *
 * Verificado contra prod: "VACHERAND SILVIO GABRIEL" → apellido "VACHERAND"; "CENTENO MIGUEL
 * ANGEL" → apellido "CENTENO". Espejo del helper FE `splitName` (`GigaredPanel.tsx:58-67`,
 * "#47e B: the FIRST token is the lastName").
 */
import { splitCustomerName } from '@application/use-cases/gigared/splitCustomerName';

describe('splitCustomerName (B8, D1) — split APELLIDO-primero', () => {
  it('"VACHERAND SILVIO GABRIEL" → lastName "VACHERAND", firstName "SILVIO GABRIEL"', () => {
    expect(splitCustomerName('VACHERAND SILVIO GABRIEL')).toEqual({
      lastName: 'VACHERAND',
      firstName: 'SILVIO GABRIEL',
    });
  });

  it('"CENTENO MIGUEL ANGEL" → lastName "CENTENO", firstName "MIGUEL ANGEL"', () => {
    expect(splitCustomerName('CENTENO MIGUEL ANGEL')).toEqual({
      lastName: 'CENTENO',
      firstName: 'MIGUEL ANGEL',
    });
  });

  it('un solo token ("MADONNA") → firstName y lastName son el mismo token', () => {
    expect(splitCustomerName('MADONNA')).toEqual({
      lastName: 'MADONNA',
      firstName: 'MADONNA',
    });
  });

  it('string vacía → fallback determinístico (criterio de normalizeLastName: "cliente"), nunca tira', () => {
    expect(splitCustomerName('')).toEqual({ lastName: 'cliente', firstName: 'cliente' });
  });

  it('null → fallback determinístico, nunca tira', () => {
    expect(splitCustomerName(null)).toEqual({ lastName: 'cliente', firstName: 'cliente' });
  });

  it('undefined → fallback determinístico, nunca tira', () => {
    expect(splitCustomerName(undefined)).toEqual({ lastName: 'cliente', firstName: 'cliente' });
  });

  it('solo espacios ("   ") → fallback determinístico, nunca tira', () => {
    expect(splitCustomerName('   ')).toEqual({ lastName: 'cliente', firstName: 'cliente' });
  });

  it('espacios múltiples entre tokens colapsan', () => {
    expect(splitCustomerName('  VACHERAND   SILVIO  GABRIEL  ')).toEqual({
      lastName: 'VACHERAND',
      firstName: 'SILVIO GABRIEL',
    });
  });
});
