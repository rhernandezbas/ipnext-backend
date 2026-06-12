/**
 * Shared int4-overflow guard for numeric search terms.
 *
 * Both the tickets and scheduling search boxes accept a free-text term. When a
 * user pastes a phone number or CUIT (e.g. "11445566778"), it parses as a valid
 * number but overflows PostgreSQL's signed 32-bit `int4` column type backing
 * `sequenceNumber`. Prisma then throws a PrismaClientValidationError → HTTP 500.
 *
 * This helper centralizes the decision of whether a search term is eligible to
 * participate in an exact `sequenceNumber` match. It returns the Prisma-shaped
 * equality clause when the term is a non-negative integer that fits int4, and
 * `null` otherwise (non-numeric, negative, decimal, empty, or out of range).
 *
 * Keeping it Prisma-client-free makes it unit-testable in isolation: the guard
 * has real coverage, so deleting it breaks the unit test (not just an
 * integration test that happens to exercise it).
 */

/** Max value of a PostgreSQL signed 32-bit integer (int4). */
export const INT4_MAX = 2147483647;

/**
 * Returns an exact-match clause `{ sequenceNumber: n }` when `search` is a
 * non-negative integer within int4 range, or `null` when the term must not
 * participate in the numeric arm of the search.
 */
export function sequenceNumberClause(search: string): { sequenceNumber: number } | null {
  // Only plain non-negative integer strings are candidates. This rejects "",
  // "-5", "12.5", "12e3", "0x1f", whitespace, etc. before we ever call Number().
  if (!/^\d+$/.test(search)) return null;

  const n = Number(search);
  // Number.isSafeInteger guards against >2^53 strings that lose precision; the
  // int4 ceiling guards against PostgreSQL overflow. Both must hold.
  if (!Number.isSafeInteger(n) || n > INT4_MAX) return null;

  return { sequenceNumber: n };
}
