import { InMemoryClientMirrorReadRepository } from '@infrastructure/adapters/in-memory/InMemoryClientMirrorReadRepository';
import { InMemoryGestionRealPort } from '@infrastructure/adapters/in-memory/InMemoryGestionRealPort';
import { InMemoryClientMirrorRepository } from '@infrastructure/adapters/in-memory/InMemoryClientMirrorRepository';
import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { SyncGestionRealContracts } from '@application/use-cases/SyncGestionRealContracts';
import { BackfillGrContractsBatch } from '@application/use-cases/BackfillGrContractsBatch';
import { GrContract } from '@domain/entities/gestionReal';

const BACKFILL_ENTITY = 'gr-contracts-backfill';

function contract(id: string, cli: string): GrContract {
  return {
    grContratoId: id, grClienteId: cli, plan: '50MB', status: 'Vigente',
    startDate: '01-01-2026', address: null, lat: null, lng: null, pppoeUsername: null, modificado: null, raw: {},
  };
}

function makeFixture(ids: string[], batchSize: number) {
  const mirrorRead = new InMemoryClientMirrorReadRepository(ids);
  const gr = new InMemoryGestionRealPort();
  // Seed one contract per client so fetch returns something to upsert.
  gr.contractsByClient = Object.fromEntries(ids.map((id) => [id, [contract(`k-${id}`, id)]]));
  const mirror = new InMemoryClientMirrorRepository();
  const state = new InMemorySyncStateRepository();
  const syncContracts = new SyncGestionRealContracts(gr, mirror);
  const uc = new BackfillGrContractsBatch(mirrorRead, syncContracts, state, batchSize);
  return { mirrorRead, gr, mirror, state, syncContracts, uc };
}

async function arm(state: InMemorySyncStateRepository): Promise<void> {
  await state.save({ entity: BACKFILL_ENTITY, cursor: '0', lastRunAt: null, lastResult: 'armed', itemsSynced: 0 });
}

describe('BackfillGrContractsBatch', () => {
  it('bounded + advances: one batch processes batchSize ids and advances the watermark (REQ-BACKFILL-1)', async () => {
    const { gr, mirror, state, uc } = makeFixture(['c1', 'c2', 'c3', 'c4', 'c5'], 2);
    await arm(state);
    const spy = jest.spyOn(gr, 'fetchContractsByClient');

    const result = await uc.execute();

    expect(spy.mock.calls.map((c) => c[0])).toEqual(['c1', 'c2']);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(mirror.contracts.has('k-c1')).toBe(true);
    expect(mirror.contracts.has('k-c2')).toBe(true);
    expect((await state.get(BACKFILL_ENTITY))?.cursor).toBe('2');
    expect(result.processed).toBe(2);
    expect(result.done).toBe(false);
    expect(result.nextOffset).toBe(2);
  });

  it('drains then disarms: successive batches cover the universe, then no-op (REQ-BACKFILL-2)', async () => {
    const { gr, state, uc } = makeFixture(['c1', 'c2', 'c3'], 2);
    await arm(state);
    const spy = jest.spyOn(gr, 'fetchContractsByClient');

    const first = await uc.execute();
    expect(first.processed).toBe(2);
    expect(first.done).toBe(false);
    expect((await state.get(BACKFILL_ENTITY))?.cursor).toBe('2');

    const second = await uc.execute();
    expect(spy.mock.calls.map((c) => c[0])).toEqual(['c1', 'c2', 'c3']);
    expect(second.processed).toBe(1);
    expect(second.done).toBe(true);
    expect((await state.get(BACKFILL_ENTITY))?.cursor).toBeNull();

    spy.mockClear();
    const third = await uc.execute();
    expect(third.processed).toBe(0);
    expect(third.done).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    expect((await state.get(BACKFILL_ENTITY))?.cursor).toBeNull();
  });

  it('not-armed no-op: disarmed (no row / cursor null) returns done with zero GR calls', async () => {
    const { gr, state, uc } = makeFixture(['c1', 'c2', 'c3'], 2);
    const spy = jest.spyOn(gr, 'fetchContractsByClient');

    // No row at all.
    const noRow = await uc.execute();
    expect(noRow).toMatchObject({ processed: 0, done: true });
    expect(spy).not.toHaveBeenCalled();

    // Explicit done row (cursor null).
    await state.save({ entity: BACKFILL_ENTITY, cursor: null, lastRunAt: null, lastResult: 'done', itemsSynced: 3 });
    const doneRow = await uc.execute();
    expect(doneRow).toMatchObject({ processed: 0, done: true });
    expect(spy).not.toHaveBeenCalled();
  });

  it('resume after restart: a new instance over the same state continues from the offset (REQ-BACKFILL-3)', async () => {
    const ids = ['c1', 'c2', 'c3', 'c4'];
    const { gr, mirror, state, uc } = makeFixture(ids, 2);
    await arm(state);

    await uc.execute(); // instance A: c1,c2 → cursor '2'
    expect((await state.get(BACKFILL_ENTITY))?.cursor).toBe('2');

    // Simulate a container restart: brand-new instance, SAME state repo.
    const grB = new InMemoryGestionRealPort();
    grB.contractsByClient = Object.fromEntries(ids.map((id) => [id, [contract(`k-${id}`, id)]]));
    const syncContractsB = new SyncGestionRealContracts(grB, mirror);
    const readB = new InMemoryClientMirrorReadRepository(ids);
    const ucB = new BackfillGrContractsBatch(readB, syncContractsB, state, 2);
    const spyB = jest.spyOn(grB, 'fetchContractsByClient');

    const result = await ucB.execute();

    expect(spyB.mock.calls.map((c) => c[0])).toEqual(['c3', 'c4']);
    expect(spyB).not.toHaveBeenCalledWith('c1');
    expect(spyB).not.toHaveBeenCalledWith('c2');
    expect(result.done).toBe(true);
    expect((await state.get(BACKFILL_ENTITY))?.cursor).toBeNull();
  });
});
