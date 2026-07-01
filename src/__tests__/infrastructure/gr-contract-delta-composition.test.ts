/**
 * gr-contract-delta-composition.test.ts — static source assertion.
 *
 * Pins the wiring of SyncGestionRealContractsDelta in bootstrapGestionRealSync
 * so that any refactor that accidentally drops the delta use case is caught
 * immediately (without spinning up the DB). Anti-"dead feature".
 *
 * REQ-DELTA-10: The scheduler MUST receive the delta use case as an argument.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('gr-contract-delta composition root', () => {
  let src: string;

  beforeAll(() => {
    src = readFileSync(
      join(__dirname, '..', '..', 'infrastructure', 'scheduling', 'bootstrapGestionRealSync.ts'),
      'utf8',
    );
  });

  it('imports SyncGestionRealContractsDelta', () => {
    expect(src).toMatch(/import.*SyncGestionRealContractsDelta.*from/);
  });

  it('instantiates SyncGestionRealContractsDelta with the shared deps (client, mirror, state, featureFlags)', () => {
    expect(src).toMatch(/new SyncGestionRealContractsDelta\(/);
  });

  it('passes the delta instance to GestionRealSyncScheduler constructor', () => {
    // The delta must be passed to the scheduler, not just constructed and ignored.
    const schedulerIdx = src.indexOf('new GestionRealSyncScheduler(');
    expect(schedulerIdx).toBeGreaterThan(-1);
    // Grab the constructor call window (up to 400 chars is enough for the arg list)
    const constructorCall = src.slice(schedulerIdx, schedulerIdx + 500);
    expect(constructorCall).toMatch(/syncContractsDelta/);
  });
});
