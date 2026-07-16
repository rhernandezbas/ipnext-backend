/**
 * MIR-2 — source-text pin for PrismaUispDeviceRepository.upsert.
 * Guards that `apUispDeviceId` is whitelisted in BOTH the `create` and `update` blocks of the
 * Prisma upsert — mirrors the `PrismaClientMirrorRepository.upsertData.test.ts` pattern (no live
 * DB needed; the field must travel through the adapter or it silently never persists in prod
 * while in-memory tests stay green).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('PrismaUispDeviceRepository.upsert — apUispDeviceId pin', () => {
  let src: string;
  let createBlock: string;
  let updateBlock: string;

  beforeAll(() => {
    src = readFileSync(
      join(__dirname, '..', '..', 'infrastructure', 'adapters', 'prisma', 'PrismaUispDeviceRepository.ts'),
      'utf8',
    );
    const createMatch = src.match(/create:\s*\{([\s\S]*?)\},\r?\n\s*update:/);
    const updateMatch = src.match(/update:\s*\{([\s\S]*?)\},\r?\n\s*\}\);/);
    expect(createMatch).not.toBeNull();
    expect(updateMatch).not.toBeNull();
    createBlock = createMatch![1];
    updateBlock = updateMatch![1];
  });

  it('create block whitelists apUispDeviceId', () => {
    expect(createBlock).toMatch(/apUispDeviceId\s*:\s*device\.apUispDeviceId/);
  });

  it('update block whitelists apUispDeviceId', () => {
    expect(updateBlock).toMatch(/apUispDeviceId\s*:\s*device\.apUispDeviceId/);
  });
});
