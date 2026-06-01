import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { ResetGrClientsCursor } from '@application/use-cases/ResetGrClientsCursor';
import { ArmGrContractsBackfill } from '@application/use-cases/ArmGrContractsBackfill';
import { ResyncAllGr } from '@application/use-cases/ResyncAllGr';

describe('ResyncAllGr', () => {
  function makeUc(state: InMemorySyncStateRepository): ResyncAllGr {
    const reset = new ResetGrClientsCursor(state);
    const arm = new ArmGrContractsBackfill(state);
    return new ResyncAllGr(reset, arm);
  }

  it('resets the gr-clients cursor AND arms the contract backfill at offset 0', async () => {
    const state = new InMemorySyncStateRepository();
    await state.save({
      entity: 'gr-clients', cursor: '25-05-2026', lastRunAt: new Date(), lastResult: 'ok', itemsSynced: 100,
    });
    const uc = makeUc(state);

    const result = await uc.execute();

    expect(result).toEqual({
      clients: { entity: 'gr-clients', cursor: null },
      contractsBackfill: { armed: true, offset: 0 },
    });
    expect((await state.get('gr-clients'))?.cursor).toBeNull();
    expect((await state.get('gr-contracts-backfill'))?.cursor).toBe('0');
  });

  it('is idempotent — a second execute leaves both watermarks reset/armed', async () => {
    const state = new InMemorySyncStateRepository();
    await state.save({
      entity: 'gr-clients', cursor: '25-05-2026', lastRunAt: new Date(), lastResult: 'ok', itemsSynced: 100,
    });
    const uc = makeUc(state);

    await uc.execute();
    const result = await uc.execute();

    expect(result.clients.cursor).toBeNull();
    expect(result.contractsBackfill).toEqual({ armed: true, offset: 0 });
    expect((await state.get('gr-clients'))?.cursor).toBeNull();
    expect((await state.get('gr-contracts-backfill'))?.cursor).toBe('0');
  });
});
