/**
 * TDD — #41 UpdateTask normalizes legacy isClosed → generalStatus.
 *
 * PUT /:id keeps accepting { isClosed } (legacy). UpdateTask normalizes it to
 * generalStatus BEFORE the snapshot/diff. Explicit generalStatus wins (precedence D4).
 */
import { UpdateTask } from '@application/use-cases/UpdateTask';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { EntityLookup } from '@domain/ports/EntityLookup';

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
