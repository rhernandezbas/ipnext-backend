import { computeSuricataContentHash } from '@domain/entities/suricataContentHash';

/**
 * suricata-tickets-mirror (Phase C, task C.2, D6.b/D12) — canonical render:
 * subject|status|priority|area|lastMessageAt|messageCount. Order-independent
 * because the input is a flat summary, never a raw message array to sort.
 */
describe('computeSuricataContentHash', () => {
  const base = {
    subject: 'No tengo internet',
    status: 'abierto',
    priority: 'alta',
    areaExternalId: 'area-1',
    lastMessageAt: '2026-09-01T10:00:00.000Z',
    messageCount: 3,
  };

  it('same ticket -> same hash (deterministic)', () => {
    expect(computeSuricataContentHash(base)).toBe(computeSuricataContentHash({ ...base }));
  });

  it('a new message (messageCount changes) -> different hash', () => {
    const withNewMessage = { ...base, messageCount: 4 };
    expect(computeSuricataContentHash(withNewMessage)).not.toBe(computeSuricataContentHash(base));
  });

  it('status change -> different hash', () => {
    const closed = { ...base, status: 'cerrado' };
    expect(computeSuricataContentHash(closed)).not.toBe(computeSuricataContentHash(base));
  });

  it('null priority/areaExternalId/lastMessageAt do not throw and still hash deterministically', () => {
    const stripped = { ...base, priority: null, areaExternalId: null, lastMessageAt: null };
    const h1 = computeSuricataContentHash(stripped);
    const h2 = computeSuricataContentHash({ ...stripped });
    expect(h1).toBe(h2);
    expect(h1).not.toBe(computeSuricataContentHash(base));
  });

  it('returns a hex sha256 digest (64 chars)', () => {
    expect(computeSuricataContentHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});
