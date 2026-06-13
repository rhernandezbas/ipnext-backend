/**
 * #81 — identidad de TV secuencial por cliente. El internal_id vigente se deriva del
 * Client.id + el seq de reactivaciones: seq=0 → id pelado (back-compat), seq>0 → {id}-{seq}.
 */
import { currentTvInternalId } from '@domain/gigared/tvIdentity';

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
