/**
 * #43 — data-block pinning (lesson 2026-06-10) for PrismaClientMirrorRepository.upsertContract.
 * Reads the source, extracts the `const data = {` object, and asserts its exact key set.
 * GR sync MUST NOT write `name` (CN-3.1/3.2) nor `technology` — both are user-owned.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('upsertContract data block pinning (#43)', () => {
  let dataBlock: string;

  beforeAll(() => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'infrastructure', 'adapters', 'prisma', 'PrismaClientMirrorRepository.ts'),
      'utf8',
    );
    // Extract the upsertContract `const data = { ... };` object.
    const fnIdx = src.indexOf('async upsertContract');
    expect(fnIdx).toBeGreaterThan(-1);
    const fnSlice = src.slice(fnIdx);
    const match = fnSlice.match(/const data = \{([\s\S]*?)\};/);
    expect(match).not.toBeNull();
    dataBlock = match![1];
  });

  it('contains exactly the GR-owned keys (including clientId for REQ-DELTA-12)', () => {
    const keys = (dataBlock.match(/^\s*(\w+)\s*:/gm) ?? []).map(k => k.trim().replace(/:$/, ''));
    expect(new Set(keys)).toEqual(new Set(['type', 'plan', 'status', 'startDate', 'address', 'lat', 'lng', 'vendedor', 'clientId']));
  });

  it('pins address as GR-wins (address: k.address)', () => {
    expect(dataBlock).toMatch(/address:\s*k\.address/);
  });

  it('does NOT contain a name: key (manual-only — CN-3)', () => {
    expect(dataBlock).not.toMatch(/(^|\s)name\s*:/);
  });

  it('does NOT contain a technology: key (user-owned)', () => {
    expect(dataBlock).not.toMatch(/(^|\s)technology\s*:/);
  });

  it('canonicalizes status via mapContractStatus (symmetric with client mapStatus)', () => {
    // The NEW data must store the canonical enum, not the raw GR estado.
    expect(dataBlock).toMatch(/status:\s*mapContractStatus\(k\.status\)/);
    // The old raw passthrough default must be gone.
    expect(dataBlock).not.toMatch(/status:\s*k\.status\s*\?\?/);
  });

  // REQ-DELTA-12: upsertContract.update MUST also reassign clientId so that a contract
  // that changes owner (titularidad) gets wired to the new client. The fix is to move
  // `clientId: parent.id` from the create-only block into the shared `data` object so
  // the update branch inherits it automatically.
  it('contains clientId in the shared data block (update also reassigns owner — REQ-DELTA-12)', () => {
    expect(dataBlock).toMatch(/clientId\s*:/);
  });
});
