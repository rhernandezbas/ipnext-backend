import { dedupeStatusHistory } from '@application/services/dedupeStatusHistory';
import { SoStatusHistoryEntry } from '@domain/entities/iclass-closed-order';

const e = (id: string, code: string): SoStatusHistoryEntry => ({
  iclassOsStatusId: id,
  occurredAt: '2026-05-21T00:00:00.000Z',
  statusCode: code,
  statusDescription: '',
  durationMinutes: 0,
  teamLogin: null,
  commentary: null,
});

describe('dedupeStatusHistory', () => {
  it('drops entries with a duplicate iclassOsStatusId, keeping the first occurrence', () => {
    // Real case: IClass returned 243692200675886940 twice for OS 4691.
    const out = dedupeStatusHistory([e('1', 'a'), e('2', 'b'), e('1', 'dup'), e('3', 'c')]);
    expect(out.map((h) => h.iclassOsStatusId)).toEqual(['1', '2', '3']);
    expect(out.find((h) => h.iclassOsStatusId === '1')!.statusCode).toBe('a'); // first kept, not the dup
  });

  it('returns the list unchanged when there are no duplicates', () => {
    const input = [e('1', 'a'), e('2', 'b')];
    expect(dedupeStatusHistory(input)).toEqual(input);
  });

  it('handles an empty history', () => {
    expect(dedupeStatusHistory([])).toEqual([]);
  });
});
