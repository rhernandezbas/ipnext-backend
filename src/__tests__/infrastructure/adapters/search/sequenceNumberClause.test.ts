import { describe, it, expect } from '@jest/globals';
import { sequenceNumberClause, INT4_MAX } from '@infrastructure/adapters/search/sequenceNumberClause';

/**
 * Falsifiable unit test for the int4-overflow guard shared by the tickets and
 * scheduling numeric search. The guard lives in a Prisma-client-free module so
 * it can be tested in isolation — deleting the range check breaks these tests.
 */
describe('sequenceNumberClause — int4-overflow guard (#63)', () => {
  it('returns null for a value that overflows int4 (phone/CUIT pasted into the box)', () => {
    // The original 500: "11445566778" parses to a valid Number but overflows
    // PostgreSQL int4 → Prisma throws. The guard skips the numeric arm.
    expect(sequenceNumberClause('11445566778')).toBeNull();
  });

  it('returns a clause for INT4_MAX (the largest in-range value)', () => {
    expect(sequenceNumberClause(String(INT4_MAX))).toEqual({ sequenceNumber: INT4_MAX });
  });

  it('returns null for INT4_MAX + 1 (boundary: first overflowing value)', () => {
    expect(sequenceNumberClause(String(INT4_MAX + 1))).toBeNull();
  });

  it('returns a clause for a small in-range integer', () => {
    expect(sequenceNumberClause('123')).toEqual({ sequenceNumber: 123 });
  });

  it('returns a clause for zero', () => {
    expect(sequenceNumberClause('0')).toEqual({ sequenceNumber: 0 });
  });

  it('returns null for a decimal', () => {
    expect(sequenceNumberClause('12.5')).toBeNull();
  });

  it('returns null for a negative number', () => {
    expect(sequenceNumberClause('-5')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(sequenceNumberClause('')).toBeNull();
  });

  it('returns null for a non-numeric term', () => {
    expect(sequenceNumberClause('abc')).toBeNull();
  });
});
