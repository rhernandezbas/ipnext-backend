import type { ActiveClientContact } from '@domain/ports/CustomerRepository';
import type { CustomerStatus } from '@domain/entities/customer';

/**
 * "Posible cliente activo" detector (recapture-active-client-match).
 *
 * Pure, total function — analogous to `deriveTechnology`. Normalizes BOTH sides
 * (lead + candidate) and computes 4 informational signals in memory. Never
 * mutates its inputs, never throws (garbage/null data degrades to "no match"
 * for that signal, not an exception — design.md Decisión 3, fail-open).
 */

// ─── Phone normalization (design.md Decisión 2) ─────────────────────────────

/** Compare the last N digits — survives either side including/omitting the area code. */
export const PHONE_SUFFIX_LENGTH = 8;
/** Below this many significant digits, a phone is treated as garbage (never matches). */
export const PHONE_MIN_SIGNIFICANT_DIGITS = 6;

const CHURN_REASON_KEYWORD = 'titularidad';

/**
 * Normalizes a raw phone string into a comparable digit-only key, or `null`
 * when the input is missing/too short to be significant.
 *
 * Steps (design.md Decisión 2, applied in order to the progressively-stripped
 * digit string):
 *  1. null/empty            → null
 *  2. strip every non-digit
 *  3. drop a leading "54" country code IF the remaining length is >= 11
 *  4. drop leading zeros (trunk prefix), one or more
 *  5. drop a leading "9" mobile marker IF the remaining length is >= 11
 *  6. drop a leading "15" ONLY when it sits at the very front (does NOT strip
 *     a "15" embedded between area code and subscriber number — documented gap,
 *     fixing it needs an area-code table, out of scope)
 *  7. floor: fewer than PHONE_MIN_SIGNIFICANT_DIGITS digits → null (garbage guard)
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;

  let digits = raw.replace(/\D/g, '');
  if (digits.length === 0) return null;

  if (digits.length >= 11 && digits.startsWith('54')) {
    digits = digits.slice(2);
  }
  while (digits.length > 0 && digits.startsWith('0')) {
    digits = digits.slice(1);
  }
  if (digits.length >= 11 && digits.startsWith('9')) {
    digits = digits.slice(1);
  }
  if (digits.startsWith('15')) {
    digits = digits.slice(2);
  }

  if (digits.length < PHONE_MIN_SIGNIFICANT_DIGITS) return null;
  return digits;
}

/**
 * Compares two ALREADY-NORMALIZED phone keys by their last
 * `min(PHONE_SUFFIX_LENGTH, a.length, b.length)` digits. `null` on either side
 * (or below the significance floor) never matches — total, never throws.
 */
export function suffixMatch(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  if (a.length < PHONE_MIN_SIGNIFICANT_DIGITS || b.length < PHONE_MIN_SIGNIFICANT_DIGITS) return false;
  const n = Math.min(PHONE_SUFFIX_LENGTH, a.length, b.length);
  return a.slice(-n) === b.slice(-n);
}

/** lowercase + trim on both sides; `null`/empty never match (spec: exact match, not substring). */
function normalizeEmail(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const normalized = raw.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

/** Case-insensitive substring scan over a source-agnostic list of free-text reasons. */
function hasChurnReasonSignal(texts: readonly string[] | null | undefined): boolean {
  if (!texts || texts.length === 0) return false;
  return texts.some((text) => typeof text === 'string' && text.toLowerCase().includes(CHURN_REASON_KEYWORD));
}

// ─── Public types (Wire Contract — tasks.md §0, spec.md is authoritative) ───

export type ActiveMatchSignal = 'phone' | 'email' | 'reactivated' | 'churn_reason';

export interface MatchedClientSummary {
  clientId: string;
  name: string;
  status: CustomerStatus;
  matchedBy: Array<'phone' | 'email' | 'reactivated'>;
}

export interface MatchActiveClientLead {
  clientId: string | null;
  phone: string | null;
  email: string | null;
}

export interface MatchActiveClientResult {
  signals: ActiveMatchSignal[];
  matchedClients: MatchedClientSummary[];
}

type ContactSignal = 'phone' | 'email' | 'reactivated';

/**
 * Computes the "posible cliente activo" signals for a single lead against the
 * batch of currently-active client contacts (`CustomerRepository.listActiveContacts()`).
 *
 * - phone/email signals EXCLUDE the lead's own `clientId` (that case is exclusively
 *   covered by `reactivated`).
 * - `reactivated` fires ONLY when `lead.clientId` itself appears in `activeContacts`.
 * - Multiple matched clients are all reported (deduplicated by clientId); the
 *   top-level `signals` is the deduplicated union across every match.
 * - `churnReasonTexts` is SOURCE-AGNOSTIC and independent of `lead`: the helper
 *   has zero knowledge of where the text(s) came from. The CALLER merges
 *   whatever sources apply (CSV `churnReason` today, GR `Contract.motivoBaja`
 *   tomorrow, or both) into a flat array BEFORE calling this function.
 * - Total function: malformed/null candidate entries are skipped, never thrown.
 */
export function matchActiveClient(
  lead: MatchActiveClientLead,
  activeContacts: readonly ActiveClientContact[] | null | undefined,
  churnReasonTexts: readonly string[] | null | undefined,
): MatchActiveClientResult {
  const contacts = (activeContacts ?? []).filter(
    (c): c is ActiveClientContact => !!c && typeof c.id === 'string' && c.id.length > 0,
  );

  const signals = new Set<ActiveMatchSignal>();
  const matchedBySignal = new Map<string, Set<ContactSignal>>();

  const recordMatch = (clientId: string, by: ContactSignal) => {
    signals.add(by);
    const existing = matchedBySignal.get(clientId) ?? new Set<ContactSignal>();
    existing.add(by);
    matchedBySignal.set(clientId, existing);
  };

  const leadPhoneKey = normalizePhone(lead.phone);
  const leadEmailKey = normalizeEmail(lead.email);

  for (const contact of contacts) {
    const isOwnClient = lead.clientId !== null && contact.id === lead.clientId;
    if (isOwnClient) continue; // own client is covered exclusively by `reactivated`

    if (leadPhoneKey && suffixMatch(leadPhoneKey, normalizePhone(contact.phone))) {
      recordMatch(contact.id, 'phone');
    }
    if (leadEmailKey && leadEmailKey === normalizeEmail(contact.email)) {
      recordMatch(contact.id, 'email');
    }
  }

  if (lead.clientId !== null) {
    const ownActiveContact = contacts.find((c) => c.id === lead.clientId);
    if (ownActiveContact) {
      recordMatch(ownActiveContact.id, 'reactivated');
    }
  }

  if (hasChurnReasonSignal(churnReasonTexts)) {
    signals.add('churn_reason');
  }

  const matchedClients: MatchedClientSummary[] = [];
  for (const [clientId, by] of matchedBySignal.entries()) {
    const contact = contacts.find((c) => c.id === clientId);
    matchedClients.push({
      clientId,
      name: contact?.name ?? '',
      // `activeContacts` is, by construction, the status='active' candidate set
      // (CustomerRepository.listActiveContacts()) — every match is active.
      status: 'active',
      matchedBy: Array.from(by),
    });
  }

  return {
    signals: Array.from(signals),
    matchedClients,
  };
}
