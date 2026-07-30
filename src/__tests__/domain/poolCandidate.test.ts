/**
 * gigared-tv-cic-reuse (T1.3) — clasificador PURO de una entrada del pool `unregistered`.
 *
 * Refina el filtro anti-veneno B1 (post-incidente Centeno), que rechazaba TODO cic estampado
 * sin mirar de quién era la identidad. No distinguía dos casos que no se parecen en nada:
 *
 *   - PELIGROSO: el cic carga la identidad de un tercero VIVO → se asigna en silencio y nadie
 *     se entera. Es el incidente Centeno. Sigue bloqueado.
 *   - SEGURO: el cic carga la identidad de un cliente NUESTRO ya severado localmente
 *     (`tvCancelledAt`). Reutilizarlo es el comportamiento deseado.
 *
 * Este clasificador resuelve la parte SÍNCRONA. La tercera condición de la invariante
 * (elegibilidad del cliente) es asíncrona y vive en `TvCicReuseEligibilityRepository`.
 */
import { classifyPoolEntry } from '@domain/gigared/poolCandidate';

const GUILLEN = 'bb25d17b-4770-48e3-9686-d9d9929e1898';
const MALLORQUIN = '7d4e3ec6-34b0-440c-b7c2-6f263f3e6f8f';

describe('gigared-tv-cic-reuse T1.3 — classifyPoolEntry', () => {
  it('cic válido + internal_id vacío → limpio (el candidato preferido)', () => {
    expect(classifyPoolEntry({ cic: '0006677401', internalId: null })).toEqual({ kind: 'limpio' });
    expect(classifyPoolEntry({ cic: '0006677401', internalId: '' })).toEqual({ kind: 'limpio' });
    expect(classifyPoolEntry({ cic: '0006677401', internalId: undefined })).toEqual({
      kind: 'limpio',
    });
  });

  it('cic con formato inválido → malformado (nunca candidato)', () => {
    expect(classifyPoolEntry({ cic: '00065470 4', internalId: null })).toEqual({
      kind: 'malformado',
    });
    expect(classifyPoolEntry({ cic: '', internalId: null })).toEqual({ kind: 'malformado' });
    expect(classifyPoolEntry({ cic: null, internalId: null })).toEqual({ kind: 'malformado' });
  });

  it('cic válido + identidad NUESTRA → requiere-verificacion, con el clientId extraído', () => {
    expect(classifyPoolEntry({ cic: '0006677401', internalId: GUILLEN })).toEqual({
      kind: 'requiere-verificacion',
      clientId: GUILLEN,
    });
  });

  it('identidad nuestra CON seq de re-alta → también requiere-verificacion (caso MALLORQUIN)', () => {
    expect(classifyPoolEntry({ cic: '0006450297', internalId: `${MALLORQUIN}-1` })).toEqual({
      kind: 'requiere-verificacion',
      clientId: MALLORQUIN,
    });
  });

  it('cic válido + identidad NO parseable → ajeno (jamás se reutiliza)', () => {
    expect(classifyPoolEntry({ cic: '0006677401', internalId: 'MI_CLIENTE_001' })).toEqual({
      kind: 'ajeno',
    });
    expect(classifyPoolEntry({ cic: '0006677401', internalId: 'cust-1' })).toEqual({
      kind: 'ajeno',
    });
  });

  it('ORDEN DE GUARDAS: el formato del cic se evalúa ANTES que la identidad', () => {
    // Un cic malformado con identidad ajena es `malformado`, no `ajeno`: el cic no sirve
    // para nada aunque la identidad hubiera sido reutilizable.
    expect(classifyPoolEntry({ cic: '00065470 4', internalId: 'MI_CLIENTE_001' })).toEqual({
      kind: 'malformado',
    });
    expect(classifyPoolEntry({ cic: '00065470 4', internalId: GUILLEN })).toEqual({
      kind: 'malformado',
    });
  });

  it('es PURO: no muta la entrada', () => {
    const entry = { cic: '0006677401', internalId: GUILLEN };
    const copia = { ...entry };
    classifyPoolEntry(entry);
    expect(entry).toEqual(copia);
  });

  describe('el pool REAL de producción del 2026-07-30', () => {
    // Las 10 cuentas exactas que tenía el partner cuando el alta estaba rota al 100%.
    const POOL = [
      { cic: '0006677401', internalId: GUILLEN },
      { cic: '0006168430', internalId: 'd888bea2-7833-494b-b3a6-b246284ef4e9' },
      { cic: '0006832019', internalId: '2815a6b3-e104-4c86-9d0b-bc1e45b49aca' },
      { cic: '0006107090', internalId: 'e2772dda-bf27-4998-8482-885454e532ab' },
      { cic: '0006411239', internalId: '6a31c2c9-56cf-4d05-87a2-96827182499a' },
      { cic: '0006450297', internalId: `${MALLORQUIN}-1` },
      { cic: '0006166000', internalId: '3ef5eb6e-bc75-41a5-b816-8336c739497b' }, // ALVEZ SUSANA
      { cic: '0006871501', internalId: 'ab00f71d-2e76-4038-9510-166fc205e5e3' },
      { cic: '00065470 4', internalId: null }, // el corrupto que rompía todo
      { cic: '0006282445', internalId: '97efa072-2fe1-48e4-b828-bf247533f374' },
    ];

    it('NINGUNA entrada clasifica como `limpio` — por eso no había alta posible', () => {
      const kinds = POOL.map(e => classifyPoolEntry(e).kind);
      expect(kinds.filter(k => k === 'limpio')).toHaveLength(0);
    });

    it('el único sin internal_id clasifica `malformado`, NO `limpio` (el fix del bug)', () => {
      expect(classifyPoolEntry(POOL[8])).toEqual({ kind: 'malformado' });
    });

    it('las 9 estampadas quedan en `requiere-verificacion` (el async decide, no el filtro)', () => {
      const kinds = POOL.map(e => classifyPoolEntry(e).kind);
      expect(kinds.filter(k => k === 'requiere-verificacion')).toHaveLength(9);
    });
  });
});
