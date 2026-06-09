import {
  createReturnSuggestion,
  normalizeSerial,
} from '@domain/entities/return-suggestion';

describe('return-suggestion entity', () => {
  describe('normalizeSerial', () => {
    it('trims, uppercases, and strips non-alphanumerics', () => {
      expect(normalizeSerial('  sn-001 ')).toBe('SN001');
      expect(normalizeSerial('aa:bb:cc:dd:ee:ff')).toBe('AABBCCDDEEFF');
      expect(normalizeSerial('SN 002')).toBe('SN002');
    });

    it('returns null for null/undefined/blank', () => {
      expect(normalizeSerial(null)).toBeNull();
      expect(normalizeSerial(undefined)).toBeNull();
      expect(normalizeSerial('   ')).toBeNull();
      expect(normalizeSerial('---')).toBeNull();
    });

    it('is deterministic — same input maps to the same key (sourceRef stability)', () => {
      expect(normalizeSerial('SN-001')).toBe(normalizeSerial('sn 0 0 1'));
    });
  });

  describe('createReturnSuggestion', () => {
    it('defaults status to pending, resolution and movement to null', () => {
      const s = createReturnSuggestion({
        id: 'r1',
        taskId: 't1',
        serviceOrderId: 'so1',
        serialNumber: 'SN001',
        matchedAssetId: 'a1',
      });
      expect(s.status).toBe('pending');
      expect(s.resolution).toBeNull();
      expect(s.confirmedMovementId).toBeNull();
      expect(s.matchedAssetId).toBe('a1');
      expect(s.serialNumber).toBe('SN001');
      expect(s.createdAt).toEqual(s.updatedAt);
    });

    it('honors an explicit needs_review status with no match', () => {
      const s = createReturnSuggestion({
        id: 'r2',
        taskId: 't1',
        serviceOrderId: 'so1',
        serialNumber: 'SN-UNKNOWN',
        status: 'needs_review',
      });
      expect(s.status).toBe('needs_review');
      expect(s.matchedAssetId).toBeNull();
    });

    it('nulls optional fields when omitted', () => {
      const s = createReturnSuggestion({ id: 'r3', taskId: 't1', serviceOrderId: 'so1' });
      expect(s.serialNumber).toBeNull();
      expect(s.mac).toBeNull();
      expect(s.deviceType).toBeNull();
      expect(s.matchedAssetId).toBeNull();
    });
  });
});
