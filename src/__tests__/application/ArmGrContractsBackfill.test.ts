import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { ArmGrContractsBackfill } from '@application/use-cases/ArmGrContractsBackfill';

const BACKFILL_ENTITY = 'gr-contracts-backfill';

describe('ArmGrContractsBackfill', () => {
  async function assertArmed(state: InMemorySyncStateRepository): Promise<void> {
    const after = await state.get(BACKFILL_ENTITY);
    expect(after?.cursor).toBe('0');
    expect(after?.lastResult).toBe('armed');
    expect(after?.itemsSynced).toBe(0);
  }

  it('arms from no prior row → cursor "0", lastResult armed, itemsSynced 0 (REQ-BACKFILL-ARM-1)', async () => {
    const state = new InMemorySyncStateRepository();
    const uc = new ArmGrContractsBackfill(state);

    const result = await uc.execute();

    expect(result).toEqual({ armed: true, offset: 0 });
    await assertArmed(state);
  });

  it('arms from a mid-offset row → resets cursor to "0" (REQ-BACKFILL-ARM-1)', async () => {
    const state = new InMemorySyncStateRepository();
    await state.save({ entity: BACKFILL_ENTITY, cursor: '7', lastRunAt: new Date(), lastResult: 'batch ok @7', itemsSynced: 7 });
    const uc = new ArmGrContractsBackfill(state);

    const result = await uc.execute();

    expect(result).toEqual({ armed: true, offset: 0 });
    await assertArmed(state);
  });

  it('arms from a done row (cursor null) → re-arms at "0" (idempotent over any prior state)', async () => {
    const state = new InMemorySyncStateRepository();
    await state.save({ entity: BACKFILL_ENTITY, cursor: null, lastRunAt: new Date(), lastResult: 'done', itemsSynced: 42 });
    const uc = new ArmGrContractsBackfill(state);

    await uc.execute();
    // Arm twice — still armed at 0.
    const result = await uc.execute();

    expect(result).toEqual({ armed: true, offset: 0 });
    await assertArmed(state);
  });
});
