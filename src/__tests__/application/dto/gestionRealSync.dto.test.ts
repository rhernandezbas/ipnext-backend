import {
  toSyncConfigDTO,
  UpdateSyncConfigSchema,
} from '@application/dto/gestionRealSync.dto';

describe('gestionRealSync.dto', () => {
  describe('toSyncConfigDTO', () => {
    it('maps domain SyncConfig → DTO (no id / updatedAt leak)', () => {
      const dto = toSyncConfigDTO({ intervalMs: 300000, estados: ['1', '3', '6'] });

      expect(dto).toEqual({ intervalMs: 300000, estados: ['1', '3', '6'] });
      expect(dto).not.toHaveProperty('id');
      expect(dto).not.toHaveProperty('updatedAt');
    });
  });

  describe('UpdateSyncConfigSchema', () => {
    it('accepts a partial intervalMs-only body', () => {
      const parsed = UpdateSyncConfigSchema.safeParse({ intervalMs: 300000 });
      expect(parsed.success).toBe(true);
    });

    it('accepts a partial estados-only body', () => {
      const parsed = UpdateSyncConfigSchema.safeParse({ estados: ['1', '6'] });
      expect(parsed.success).toBe(true);
    });

    it('accepts an empty body (full partial)', () => {
      const parsed = UpdateSyncConfigSchema.safeParse({});
      expect(parsed.success).toBe(true);
    });

    it('rejects a non-numeric intervalMs', () => {
      const parsed = UpdateSyncConfigSchema.safeParse({ intervalMs: 'soon' });
      expect(parsed.success).toBe(false);
    });

    it('rejects intervalMs = 0 (must be positive)', () => {
      const parsed = UpdateSyncConfigSchema.safeParse({ intervalMs: 0 });
      expect(parsed.success).toBe(false);
    });

    it('rejects an estado outside the whitelist', () => {
      const parsed = UpdateSyncConfigSchema.safeParse({ estados: ['9'] });
      expect(parsed.success).toBe(false);
    });
  });
});
