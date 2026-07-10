/**
 * matchActiveClient — pure helper, TDD (recapture-active-client-match, batch 1).
 * Covers: normalizePhone (design §Decisión 2 table), suffixMatch, email exact/trim/case,
 * churn-reason substring (source-agnostic 3rd param — the helper knows nothing about
 * where the text(s) came from), reactivated, exclusion of the lead's own clientId from
 * contact signals, garbage/null robustness (never throws), and dedup across multiple
 * matched clients.
 *
 * Spec scenarios pinned: S2, S3, S4a, S4b, S5, S6a, S6b, S7a, S7b, S8.
 */
import {
  normalizePhone,
  suffixMatch,
  matchActiveClient,
  MatchActiveClientLead,
} from '../../../application/use-cases/recapture/matchActiveClient';
import type { ActiveClientContact } from '../../../domain/ports/CustomerRepository';

function makeLead(overrides: Partial<MatchActiveClientLead> = {}): MatchActiveClientLead {
  return {
    clientId: null,
    phone: null,
    email: null,
    ...overrides,
  };
}

function makeContact(overrides: Partial<ActiveClientContact> = {}): ActiveClientContact {
  return {
    id: 'c-default',
    name: 'Default Name',
    phone: null,
    email: null,
    ...overrides,
  };
}

// ─── normalizePhone — design §Decisión 2 table ──────────────────────────────

describe('normalizePhone', () => {
  it('strips dashes (local number with hyphen)', () => {
    expect(normalizePhone('2324-421234')).toBe('2324421234');
  });

  it('strips a single leading trunk 0 + space separator', () => {
    expect(normalizePhone('02324 421234')).toBe('2324421234');
  });

  it('strips +54 country code and the leading 9 mobile marker', () => {
    expect(normalizePhone('+54 9 2324 421234')).toBe('2324421234');
  });

  it('does NOT strip a 15 embedded between area and subscriber (documented gap)', () => {
    // "15" is only stripped when it sits at the very front of the digit string.
    expect(normalizePhone('2324 15 421234')).toBe('232415421234');
  });

  it('returns null for garbage below the 6-digit significance floor', () => {
    expect(normalizePhone('123')).toBeNull();
    expect(normalizePhone('n/a')).toBeNull();
  });

  it('returns null for null, undefined and empty string', () => {
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
    expect(normalizePhone('')).toBeNull();
  });

  it('keeps a number exactly at the 6-digit floor (boundary, not stripped further)', () => {
    expect(normalizePhone('123456')).toBe('123456');
  });

  it('strips repeated leading zeros', () => {
    expect(normalizePhone('0011 15551234')).toBe('1115551234');
  });
});

// ─── suffixMatch ─────────────────────────────────────────────────────────────

describe('suffixMatch', () => {
  it('matches when the last 8 digits are equal, regardless of total length', () => {
    expect(suffixMatch('2324421234', '999932324421234')).toBe(true);
  });

  it('does not match when the last 8 digits differ', () => {
    expect(suffixMatch('2324421234', '2324421235')).toBe(false);
  });

  it('rejects a comparison where either side is below the 6-digit floor', () => {
    expect(suffixMatch('12345', '9912345')).toBe(false);
  });

  it('never throws on null input on either side', () => {
    expect(suffixMatch(null, '12345678')).toBe(false);
    expect(suffixMatch('12345678', null)).toBe(false);
    expect(suffixMatch(null, null)).toBe(false);
  });
});

// ─── matchActiveClient — signals + matchedClients ───────────────────────────
// churnReasonTexts is the 3rd, INDEPENDENT parameter (Wire Contract, tasks.md §0):
// matchActiveClient(lead, activeContacts, churnReasonTexts). The helper has zero
// knowledge of where those texts came from — the caller merges CSV churnReason +
// (future) GR motivo_baja BEFORE calling this function.

describe('matchActiveClient', () => {
  it('S2: phone signal fires for equivalent formats (+54/9/0/hyphen)', () => {
    const lead = makeLead({ phone: '+54 9 2324 421234' });
    const contact = makeContact({ id: 'c2', phone: '02324 421234' });
    const result = matchActiveClient(lead, [contact], []);
    expect(result.signals).toContain('phone');
    expect(result.matchedClients).toEqual([
      { clientId: 'c2', name: 'Default Name', status: 'active', matchedBy: ['phone'] },
    ]);
  });

  it('no signals when nothing matches (empty result shape)', () => {
    const lead = makeLead({ phone: '111 222 3333', email: 'lead@nomatch.com' });
    const contact = makeContact({ id: 'c9', phone: '444 555 6666', email: 'other@nomatch.com' });
    const result = matchActiveClient(lead, [contact], []);
    expect(result).toEqual({ signals: [], matchedClients: [] });
  });

  it('S3: email signal fires after lowercase + trim on both sides', () => {
    const lead = makeLead({ email: ' Juan@Mail.com ' });
    const contact = makeContact({ id: 'c3', email: 'juan@mail.com' });
    const result = matchActiveClient(lead, [contact], []);
    expect(result.signals).toContain('email');
    expect(result.matchedClients).toEqual([
      { clientId: 'c3', name: 'Default Name', status: 'active', matchedBy: ['email'] },
    ]);
  });

  it('email does not match on substring/domain-only overlap', () => {
    const lead = makeLead({ email: 'juan@mail.com' });
    const contact = makeContact({ id: 'c4', email: 'juan@mail.com.ar' });
    const result = matchActiveClient(lead, [contact], []);
    expect(result.signals).not.toContain('email');
  });

  it('S4a: short/garbage phone never throws and never signals', () => {
    const lead = makeLead({ phone: '123' });
    const contact = makeContact({ id: 'c5', phone: 'n/a' });
    expect(() => matchActiveClient(lead, [contact], [])).not.toThrow();
    expect(matchActiveClient(lead, [contact], []).signals).not.toContain('phone');
  });

  it('S4b: null/empty phone or email on either side never throws, other signals still evaluated', () => {
    const lead = makeLead({ phone: null, email: 'juan@mail.com' });
    const contact = makeContact({ id: 'c6', phone: null, email: 'juan@mail.com' });
    const result = matchActiveClient(lead, [contact], []);
    expect(result.signals).toEqual(['email']);
  });

  it('S5: the lead\'s own clientId is excluded from phone/email signals (can still reactivate)', () => {
    const lead = makeLead({ clientId: 'c1', phone: '2324-421234', email: 'juan@mail.com' });
    const ownContact = makeContact({ id: 'c1', phone: '2324-421234', email: 'juan@mail.com' });
    const result = matchActiveClient(lead, [ownContact], []);
    expect(result.signals).toEqual(['reactivated']);
    expect(result.matchedClients).toEqual([
      { clientId: 'c1', name: 'Default Name', status: 'active', matchedBy: ['reactivated'] },
    ]);
  });

  it('S6a: reactivated fires when the lead\'s own client is present in the active set', () => {
    const lead = makeLead({ clientId: 'c1' });
    const own = makeContact({ id: 'c1', name: 'Cliente Reactivado' });
    const result = matchActiveClient(lead, [own], []);
    expect(result.signals).toEqual(['reactivated']);
    expect(result.matchedClients).toEqual([
      { clientId: 'c1', name: 'Cliente Reactivado', status: 'active', matchedBy: ['reactivated'] },
    ]);
  });

  it('S6b: a distinct active client matching by phone does NOT trigger reactivated', () => {
    const lead = makeLead({ clientId: 'c1', phone: '2324-421234' }); // c1 itself is NOT in the active set
    const c2 = makeContact({ id: 'c2', phone: '02324 421234' });
    const result = matchActiveClient(lead, [c2], []);
    expect(result.signals).toEqual(['phone']);
    expect(result.matchedClients).toEqual([
      { clientId: 'c2', name: 'Default Name', status: 'active', matchedBy: ['phone'] },
    ]);
  });

  it('S7a: churn_reason fires on a case-insensitive "titularidad" substring, passed as the 3rd param', () => {
    const lead = makeLead();
    const result = matchActiveClient(lead, [], ['CAMBIO DE TITULARIDAD']);
    expect(result.signals).toEqual(['churn_reason']);
    expect(result.matchedClients).toEqual([]);
  });

  it('S7a (source-agnostic): fires when ANY of several supplied texts mentions titularidad', () => {
    // Demonstrates the caller can merge multiple reason sources (e.g. CSV text +
    // a future GR motivo_baja) into one flat array — the helper just scans
    // whatever texts it is given, with zero knowledge of their origin.
    const lead = makeLead();
    const result = matchActiveClient(lead, [], ['mudanza del cliente', 'Titularidad del servicio']);
    expect(result.signals).toEqual(['churn_reason']);
  });

  it('S7b: no churn_reason signal when the texts array is empty (e.g. churned_client source today)', () => {
    const lead = makeLead();
    const result = matchActiveClient(lead, [], []);
    expect(result.signals).not.toContain('churn_reason');
  });

  it('churn_reason text with unrelated content does not fire the signal', () => {
    const lead = makeLead();
    const result = matchActiveClient(lead, [], ['se mudó de ciudad']);
    expect(result.signals).not.toContain('churn_reason');
  });

  it('never throws when churnReasonTexts is null/undefined (total function, degrade to no signal)', () => {
    const lead = makeLead();
    expect(() => matchActiveClient(lead, [], null)).not.toThrow();
    expect(() => matchActiveClient(lead, [], undefined)).not.toThrow();
    expect(matchActiveClient(lead, [], null).signals).not.toContain('churn_reason');
  });

  it('S8: two distinct active clients matching the same lead are both reported, phone signal deduped', () => {
    const lead = makeLead({ phone: '+54 9 2324 421234' });
    const c2 = makeContact({ id: 'c2', name: 'Ana', phone: '02324 421234' });
    const c3 = makeContact({ id: 'c3', name: 'Beto', phone: '2324-421234' });
    const result = matchActiveClient(lead, [c2, c3], []);
    expect(result.signals).toEqual(['phone']); // deduplicated union, not repeated per client
    expect(result.matchedClients).toHaveLength(2);
    expect(result.matchedClients).toEqual(
      expect.arrayContaining([
        { clientId: 'c2', name: 'Ana', status: 'active', matchedBy: ['phone'] },
        { clientId: 'c3', name: 'Beto', status: 'active', matchedBy: ['phone'] },
      ]),
    );
  });

  it('a client matched by BOTH phone and email reports both in matchedBy, deduped signals', () => {
    const lead = makeLead({ phone: '2324-421234', email: ' Juan@Mail.com ' });
    const contact = makeContact({ id: 'c7', phone: '02324 421234', email: 'juan@mail.com' });
    const result = matchActiveClient(lead, [contact], []);
    expect(result.signals.sort()).toEqual(['email', 'phone']);
    expect(result.matchedClients).toHaveLength(1);
    expect(result.matchedClients[0]!.matchedBy.sort()).toEqual(['email', 'phone']);
  });

  it('combines a contact match AND a churn_reason signal independently in the same call', () => {
    const lead = makeLead({ phone: '2324-421234' });
    const contact = makeContact({ id: 'c10', phone: '02324 421234' });
    const result = matchActiveClient(lead, [contact], ['CAMBIO DE TITULARIDAD']);
    expect(result.signals.sort()).toEqual(['churn_reason', 'phone']);
    expect(result.matchedClients).toEqual([
      { clientId: 'c10', name: 'Default Name', status: 'active', matchedBy: ['phone'] },
    ]);
  });

  it('never throws on malformed/empty candidate entries and is a total function', () => {
    const lead = makeLead({ phone: '123', email: '', clientId: null });
    const weirdContacts = [
      makeContact({ id: 'c8', phone: undefined as unknown as string, email: undefined as unknown as string }),
    ];
    expect(() => matchActiveClient(lead, weirdContacts, [])).not.toThrow();
    expect(() => matchActiveClient(lead, [], [])).not.toThrow();
    expect(() => matchActiveClient(lead, null, null)).not.toThrow();
    expect(() => matchActiveClient(lead, undefined, undefined)).not.toThrow();
  });
});
