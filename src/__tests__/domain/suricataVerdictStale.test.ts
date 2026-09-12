import { isSuricataVerdictStale } from '@domain/entities/suricataVerdictStale';

/**
 * suricata-tickets-mirror (Phase D, task D.2, design D9) — pure derivation:
 * a verdict is stale iff the ticket's CURRENT contentHash differs from the
 * one frozen on the verdict at submission time.
 */
describe('isSuricataVerdictStale', () => {
  it('same hash -> not stale', () => {
    expect(isSuricataVerdictStale({ ticketContentHash: 'hash-v1' }, 'hash-v1')).toBe(false);
  });

  it('different hash -> stale', () => {
    expect(isSuricataVerdictStale({ ticketContentHash: 'hash-v1' }, 'hash-v2')).toBe(true);
  });
});
