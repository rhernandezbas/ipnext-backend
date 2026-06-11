/**
 * #47 — Get/UpdateGigaredConfig: masking (configured + last4, full key absent) + flag toggle.
 */
import { GetGigaredConfig } from '@application/use-cases/gigared/GetGigaredConfig';
import { UpdateGigaredConfig } from '@application/use-cases/gigared/UpdateGigaredConfig';
import { InMemoryGigaredConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryGigaredConfigRepository';
import { InMemoryFeatureFlagRepository } from '@infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';

const FLAG = 'gigared-integration';

describe('GetGigaredConfig (#47)', () => {
  it('empty key → configured:false, last4 null', async () => {
    const cfg = new InMemoryGigaredConfigRepository();
    const flags = new InMemoryFeatureFlagRepository();
    const dto = await new GetGigaredConfig(cfg, flags).execute();
    expect(dto.configured).toBe(false);
    expect(dto.apiKeyLast4).toBeNull();
    expect(dto.enabled).toBe(false);
    expect(dto.baseUrl).toBe('https://partners.gigaredsa.com.ar/api/v1');
  });

  it("key 'abcdef1234' → configured:true, last4 '1234', full key absent", async () => {
    const cfg = new InMemoryGigaredConfigRepository();
    await cfg.update({ apiKey: 'abcdef1234' });
    const flags = new InMemoryFeatureFlagRepository();
    flags.seed(FLAG, true);
    const dto = await new GetGigaredConfig(cfg, flags).execute();
    expect(dto.configured).toBe(true);
    expect(dto.apiKeyLast4).toBe('1234');
    expect(dto.enabled).toBe(true);
    // full key must never appear anywhere in the serialized DTO
    expect(JSON.stringify(dto)).not.toContain('abcdef1234');
  });
});

describe('UpdateGigaredConfig (#47)', () => {
  it('apiKey only → masked DTO, baseUrl unchanged', async () => {
    const cfg = new InMemoryGigaredConfigRepository();
    const flags = new InMemoryFeatureFlagRepository();
    const dto = await new UpdateGigaredConfig(cfg, flags).execute({ apiKey: 'newkey9999' });
    expect(dto.configured).toBe(true);
    expect(dto.apiKeyLast4).toBe('9999');
    expect(dto.baseUrl).toBe('https://partners.gigaredsa.com.ar/api/v1');
    expect(JSON.stringify(dto)).not.toContain('newkey9999');
  });

  it('enabled:true → flips the gigared-integration flag ON', async () => {
    const cfg = new InMemoryGigaredConfigRepository();
    const flags = new InMemoryFeatureFlagRepository();
    const dto = await new UpdateGigaredConfig(cfg, flags).execute({ apiKey: 'k1234', enabled: true });
    expect(dto.enabled).toBe(true);
    expect((await flags.get(FLAG))?.enabled).toBe(true);
  });

  it('enabled:false → flips the flag OFF', async () => {
    const cfg = new InMemoryGigaredConfigRepository();
    const flags = new InMemoryFeatureFlagRepository();
    flags.seed(FLAG, true);
    const dto = await new UpdateGigaredConfig(cfg, flags).execute({ enabled: false });
    expect(dto.enabled).toBe(false);
    expect((await flags.get(FLAG))?.enabled).toBe(false);
  });

  it('empty body → no-op, key + flag unchanged', async () => {
    const cfg = new InMemoryGigaredConfigRepository();
    await cfg.update({ apiKey: 'keepme1234' });
    const flags = new InMemoryFeatureFlagRepository();
    flags.seed(FLAG, true);
    const dto = await new UpdateGigaredConfig(cfg, flags).execute({});
    expect(dto.apiKeyLast4).toBe('1234');
    expect(dto.enabled).toBe(true);
  });
});
