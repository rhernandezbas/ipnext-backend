/**
 * #81 — identidad de TV secuencial por cliente. El internal_id vigente se deriva del
 * Client.id + el seq de reactivaciones: seq=0 → id pelado (back-compat), seq>0 → {id}-{seq}.
 *
 * gigared-tv-cic-reuse (T1.1) — se agrega el INVERSO, `parseTvInternalId`, que responde
 * "¿este internal_id que el partner tiene colgado de un CIC del pool es NUESTRO, y de quién?".
 * Es el primer eslabón de la invariante de reutilización: si no parsea, la identidad NO es
 * nuestra y el CIC jamás se reutiliza.
 */
import { currentTvInternalId, parseTvInternalId } from '@domain/gigared/tvIdentity';

describe('#81 currentTvInternalId', () => {
  it('seq 0 → el Client.id pelado (back-compat, identidad de hoy)', () => {
    expect(currentTvInternalId('cust-1', 0)).toBe('cust-1');
  });

  it('seq negativo → también el id pelado (defensivo)', () => {
    expect(currentTvInternalId('cust-1', -1)).toBe('cust-1');
  });

  it('seq 1 → {id}-1 (primera reactivación)', () => {
    expect(currentTvInternalId('cust-1', 1)).toBe('cust-1-1');
  });

  it('seq N → {id}-N (reactivaciones sucesivas, nunca quemado)', () => {
    expect(currentTvInternalId('abc-uuid', 2)).toBe('abc-uuid-2');
    expect(currentTvInternalId('abc-uuid', 7)).toBe('abc-uuid-7');
  });
});

describe('gigared-tv-cic-reuse T1.1 — parseTvInternalId', () => {
  // UUIDs REALES del pool de producción (2026-07-30).
  const MALLORQUIN = '7d4e3ec6-34b0-440c-b7c2-6f263f3e6f8f';
  const GUILLEN = 'bb25d17b-4770-48e3-9686-d9d9929e1898';

  it('uuid pelado → clientId con seq 0 (identidad de primera alta)', () => {
    expect(parseTvInternalId(GUILLEN)).toEqual({ clientId: GUILLEN, seq: 0 });
  });

  it('uuid con sufijo numérico → clientId + seq (re-alta)', () => {
    // Caso REAL del pool: MALLORQUIN quemó un seq de re-alta.
    expect(parseTvInternalId(`${MALLORQUIN}-1`)).toEqual({ clientId: MALLORQUIN, seq: 1 });
    expect(parseTvInternalId(`${MALLORQUIN}-12`)).toEqual({ clientId: MALLORQUIN, seq: 12 });
  });

  it('sufijo -0 explícito → seq 0 (no es un caso especial)', () => {
    expect(parseTvInternalId(`${GUILLEN}-0`)).toEqual({ clientId: GUILLEN, seq: 0 });
  });

  it('acepta uuid en MAYÚSCULAS (el partner no normaliza el case)', () => {
    expect(parseTvInternalId(GUILLEN.toUpperCase())).toEqual({
      clientId: GUILLEN.toUpperCase(),
      seq: 0,
    });
  });

  // --- Todo lo que NO es nuestra identidad cae al lado SEGURO: null. ---

  it('string vacío → null', () => {
    expect(parseTvInternalId('')).toBeNull();
  });

  it('id que no es uuid → null (los ids de test tipo "cust-1" NO son reutilizables)', () => {
    expect(parseTvInternalId('cust-1')).toBeNull();
    expect(parseTvInternalId('MI_CLIENTE_001')).toBeNull();
  });

  it('sufijo no numérico → null', () => {
    expect(parseTvInternalId(`${GUILLEN}-abc`)).toBeNull();
    expect(parseTvInternalId(`${GUILLEN}-`)).toBeNull();
  });

  it('uuid con basura alrededor → null (anclado a inicio y fin)', () => {
    expect(parseTvInternalId(` ${GUILLEN}`)).toBeNull();
    expect(parseTvInternalId(`${GUILLEN} `)).toBeNull();
    expect(parseTvInternalId(`x${GUILLEN}`)).toBeNull();
    expect(parseTvInternalId(`${GUILLEN}\n`)).toBeNull();
  });

  it('uuid malformado (grupo de largo incorrecto) → null', () => {
    expect(parseTvInternalId('bb25d17b-4770-48e3-9686-d9d9929e189')).toBeNull();
    expect(parseTvInternalId('bb25d17b-4770-48e3-9686')).toBeNull();
  });

  it('round-trip: parse(current(id, seq)) devuelve el par original', () => {
    for (const seq of [0, 1, 2, 3, 4, 5]) {
      expect(parseTvInternalId(currentTvInternalId(GUILLEN, seq))).toEqual({
        clientId: GUILLEN,
        seq,
      });
    }
  });
});
