/**
 * #47 — DTOs + Zod schema for PUT /api/gigared/config body.
 * apiKey omitted = no change; '' = clear; baseUrl must be a URL when present.
 */
import {
  updateGigaredConfigSchema,
  type GigaredConfigDTO,
  type AddTvServiceResult,
} from '@application/dto/gigared.dto';

describe('updateGigaredConfigSchema (#47)', () => {
  it('accepts empty body (no-op patch)', () => {
    const r = updateGigaredConfigSchema.safeParse({});
    expect(r.success).toBe(true);
  });

  it('accepts apiKey + enabled + valid baseUrl', () => {
    const r = updateGigaredConfigSchema.safeParse({
      apiKey: 'newkey',
      baseUrl: 'https://partners.gigaredsa.com.ar/api/v1',
      enabled: true,
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.apiKey).toBe('newkey');
  });

  it('accepts empty-string apiKey (explicit clear)', () => {
    const r = updateGigaredConfigSchema.safeParse({ apiKey: '' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.apiKey).toBe('');
  });

  it('rejects a non-URL baseUrl', () => {
    const r = updateGigaredConfigSchema.safeParse({ baseUrl: 'not-a-url' });
    expect(r.success).toBe(false);
  });

  it('rejects a non-boolean enabled', () => {
    const r = updateGigaredConfigSchema.safeParse({ enabled: 'yes' });
    expect(r.success).toBe(false);
  });

  it('type witnesses compile (GigaredConfigDTO + AddTvServiceResult)', () => {
    const dto: GigaredConfigDTO = {
      configured: true,
      apiKeyLast4: '1234',
      baseUrl: 'https://x',
      enabled: false,
      updatedAt: '2026-06-30T00:00:00.000Z',
    };
    const ok: AddTvServiceResult = { gigared: 'ok', local: 'ok', contractServiceId: 'cs1' };
    const failed: AddTvServiceResult = { gigared: 'ok', local: 'failed', localError: 'boom' };
    expect(dto.apiKeyLast4).toBe('1234');
    expect(ok.local).toBe('ok');
    expect(failed.local).toBe('failed');
  });
});
