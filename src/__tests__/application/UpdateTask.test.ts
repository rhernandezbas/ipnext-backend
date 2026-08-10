/**
 * TDD — #41 UpdateTask normalizes legacy isClosed → generalStatus.
 *
 * PUT /:id keeps accepting { isClosed } (legacy). UpdateTask normalizes it to
 * generalStatus BEFORE the snapshot/diff. Explicit generalStatus wins (precedence D4).
 */
import { UpdateTask } from '@application/use-cases/UpdateTask';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { EntityLookup } from '@domain/ports/EntityLookup';
import { FakeTaskActivityRecorder } from '../helpers/FakeTaskActivityRecorder';

const ACTOR = { actorId: 'u1', actorName: 'Alice' };

class AnyLookup implements EntityLookup {
  async findById(id: string) { return { id, isNetworkProject: false }; }
}

function makeUseCase(repo: InMemorySchedulingRepository) {
  const any = new AnyLookup();
  return new UpdateTask(repo, any, any, any, any, any);
}

describe('UpdateTask — isClosed → generalStatus normalization (#41)', () => {
  it('PUT { isClosed: true } sets generalStatus=closed', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 'task-1', generalStatus: 'open', isClosed: false });
    const uc = makeUseCase(repo);

    const updated = await uc.execute('task-1', { isClosed: true }, ACTOR);

    expect(updated!.generalStatus).toBe('closed');
    expect(updated!.isClosed).toBe(true);
  });

  it('PUT { isClosed: false } sets generalStatus=open', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 'task-1', generalStatus: 'closed', isClosed: true });
    const uc = makeUseCase(repo);

    const updated = await uc.execute('task-1', { isClosed: false }, ACTOR);

    expect(updated!.generalStatus).toBe('open');
    expect(updated!.isClosed).toBe(false);
  });

  it('PUT { isClosed: true, generalStatus: dismissed } → dismissed wins (D4)', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 'task-1', generalStatus: 'open', isClosed: false });
    const uc = makeUseCase(repo);

    const updated = await uc.execute('task-1', { isClosed: true, generalStatus: 'dismissed' }, ACTOR);

    expect(updated!.generalStatus).toBe('dismissed');
    expect(updated!.isClosed).toBe(false);
  });
});

describe('UpdateTask — wave-1a (cierre atómico): generalStatus=closed routes through the guard', () => {
  it('PUT { generalStatus: "closed" } routes through closeTaskIfOpen(origin=staff)', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 'task-1', generalStatus: 'open', isClosed: false });
    const uc = makeUseCase(repo);

    const updated = await uc.execute('task-1', { generalStatus: 'closed' }, ACTOR);

    expect(updated!.generalStatus).toBe('closed');
    expect(updated!.isClosed).toBe(true);
    expect(updated!.closureOrigin).toBe('staff');
  });

  it('legacy PUT { isClosed: true } ALSO routes through the guard (normalizes to generalStatus=closed first)', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 'task-1', generalStatus: 'open', isClosed: false });
    const uc = makeUseCase(repo);

    const updated = await uc.execute('task-1', { isClosed: true }, ACTOR);

    expect(updated!.closureOrigin).toBe('staff');
  });

  it('bundled fields alongside the close are NOT dropped (FE resubmits the full body on save)', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 'task-1', generalStatus: 'open', isClosed: false, notes: 'old notes' });
    const uc = makeUseCase(repo);

    const updated = await uc.execute('task-1', { generalStatus: 'closed', notes: 'closing notes' }, ACTOR);

    expect(updated!.generalStatus).toBe('closed');
    expect(updated!.notes).toBe('closing notes');
  });

  it('records a status_changed activity on a WINNING close (same diff engine as before)', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 'task-1', generalStatus: 'open', isClosed: false });
    const recorder = new FakeTaskActivityRecorder();
    const any = new AnyLookup();
    const uc = new UpdateTask(repo, any, any, any, any, any, recorder);

    await uc.execute('task-1', { generalStatus: 'closed' }, ACTOR);

    const statusEvents = recorder.manyCalls.flatMap(m => m.events).filter(e => e.type === 'status_changed');
    expect(statusEvents).toHaveLength(1);
    expect(statusEvents[0]!.fromValue).toBe('open');
    expect(statusEvents[0]!.toValue).toBe('closed');
  });

  it('loses a race to a concurrent iclass close — returns the WINNER task, other fields still applied, no phantom status_changed', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 'task-1', generalStatus: 'open', isClosed: false, notes: 'old notes' });
    const recorder = new FakeTaskActivityRecorder();
    const any = new AnyLookup();
    const uc = new UpdateTask(repo, any, any, any, any, any, recorder);

    repo.setBeforeCloseWriteHook(async () => {
      repo.setBeforeCloseWriteHook(undefined);
      await repo.closeTaskIfOpen('task-1', { origin: 'iclass', resultCode: 'REAGENDADO' });
    });

    const updated = await uc.execute('task-1', { generalStatus: 'closed', notes: 'closing notes' }, ACTOR);

    expect(updated!.generalStatus).toBe('closed');
    expect(updated!.closureOrigin).toBe('iclass');
    // Unrelated field change still applies — this writer's loss of the CLOSURE race
    // must not silently drop other edits bundled in the same PUT.
    expect(updated!.notes).toBe('closing notes');

    const statusEvents = recorder.manyCalls.flatMap(m => m.events).filter(e => e.type === 'status_changed');
    expect(statusEvents).toHaveLength(0);
  });
});
