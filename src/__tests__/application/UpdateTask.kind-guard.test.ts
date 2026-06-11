/**
 * #40 — UpdateTask symmetric project↔kind guard.
 *
 * Mirrors CreateTask.kind-guard.test.ts. The task's CURRENT kind comes from the
 * LOADED task entity (not from the update body) — so moving a customer task onto
 * a network project (or vice-versa) via the update route must be rejected.
 *
 *  (a) update customer task → flagged (network) project   → ProjectKindMismatchError
 *  (b) update network task  → unflagged (customer) project → ProjectKindMismatchError
 *  (c) update network task  → flagged (network) project    → ok
 *  (d) update NOT touching projectId                       → no project lookup, no error
 *  (e) non-existent project                                → ReferenceNotFoundError (unchanged)
 */
import { UpdateTask } from '../../application/use-cases/UpdateTask';
import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { ReferenceNotFoundError } from '../../domain/errors/scheduling';
import { ProjectKindMismatchError } from '../../domain/errors/scheduling';
import { EntityLookup } from '../../domain/ports/EntityLookup';
import { ProjectKindLookup } from '../../domain/ports/ProjectKindLookup';

class AnyLookup implements EntityLookup {
  async findById(id: string) { return { id, isNetworkProject: false }; }
}

/** Project lookup stub returning a fixed isNetworkProject flag for known ids. */
class StubProjectKindLookup implements ProjectKindLookup {
  public calls = 0;
  constructor(private readonly flags: Record<string, boolean>) {}
  async findById(id: string) {
    this.calls++;
    if (!(id in this.flags)) return null;
    return { id, isNetworkProject: this.flags[id] };
  }
}

function buildUseCase(projectLookup: ProjectKindLookup) {
  const repo = new InMemorySchedulingRepository();
  const useCase = new UpdateTask(
    repo,
    new AnyLookup(),  // customerLookup
    new AnyLookup(),  // contractLookup
    new AnyLookup(),  // partnerLookup
    new AnyLookup(),  // adminLookup
    projectLookup,    // ProjectKindLookup (6th — widened)
    undefined,        // recorder
  );
  return { repo, useCase };
}

/** Seed a task of the given kind and return its id. */
async function seedTask(
  repo: InMemorySchedulingRepository,
  kind: 'customer' | 'network',
  projectId: string | null = null,
): Promise<string> {
  const base = {
    title: `${kind} task`,
    priority: 'normal',
    estimatedHours: 2,
    stageId: '10000000-0000-4000-a000-000000000001',
    description: null,
    address: null,
    coordinates: null,
    projectId,
    projectName: null,
    completedAt: null,
    notes: null,
    startDate: null,
    endDate: null,
    partnerId: null,
    reporterId: null,
    assigneeId: null,
    travelTimeTo: null,
    travelTimeFrom: null,
  };
  const data = kind === 'network'
    ? { ...base, category: 'maintenance', kind: 'network', networkSiteId: '1', customerId: null, contractId: null }
    : { ...base, category: 'installation', kind: 'customer', customerId: 'c-1', contractId: 'ct-1', networkSiteId: null };
  const task = await repo.createTask(data as never);
  return task.id;
}

describe('UpdateTask — project↔kind symmetric guard (#40)', () => {
  it('(a) customer task → network project → ProjectKindMismatchError', async () => {
    const { repo, useCase } = buildUseCase(new StubProjectKindLookup({ 'proj-network': true }));
    const id = await seedTask(repo, 'customer');
    await expect(
      useCase.execute(id, { projectId: 'proj-network' } as never),
    ).rejects.toBeInstanceOf(ProjectKindMismatchError);
  });

  it('(b) network task → customer project → ProjectKindMismatchError', async () => {
    const { repo, useCase } = buildUseCase(new StubProjectKindLookup({ 'proj-customer': false }));
    const id = await seedTask(repo, 'network');
    await expect(
      useCase.execute(id, { projectId: 'proj-customer' } as never),
    ).rejects.toBeInstanceOf(ProjectKindMismatchError);
  });

  it('(c) network task → network project → ok', async () => {
    const { repo, useCase } = buildUseCase(new StubProjectKindLookup({ 'proj-network': true }));
    const id = await seedTask(repo, 'network');
    const updated = await useCase.execute(id, { projectId: 'proj-network' } as never);
    expect(updated?.projectId).toBe('proj-network');
  });

  it('(d) update NOT touching projectId → no project lookup, no error', async () => {
    const lookup = new StubProjectKindLookup({ 'proj-network': true });
    const { repo, useCase } = buildUseCase(lookup);
    const id = await seedTask(repo, 'customer');
    const updated = await useCase.execute(id, { title: 'renamed' } as never);
    expect(updated?.title).toBe('renamed');
    expect(lookup.calls).toBe(0); // guard must not fire when projectId is absent
  });

  it('(e) non-existent project → ReferenceNotFoundError (NOT a kind error)', async () => {
    const { repo, useCase } = buildUseCase(new StubProjectKindLookup({}));
    const id = await seedTask(repo, 'customer');
    await expect(
      useCase.execute(id, { projectId: 'ghost' } as never),
    ).rejects.toBeInstanceOf(ReferenceNotFoundError);
  });

  // ── #40 same-project no-op: the FE edit form resubmits the UNCHANGED projectId
  // on every save. The kind guard must fire on REASSIGNMENT (change), not on the
  // mere PRESENCE of projectId — otherwise a customer task whose project was later
  // flagged isNetworkProject=true becomes un-editable (422 on every save).
  //
  // Design choice (documented here): when the incoming projectId EQUALS the task's
  // current projectId, we skip the guard AND the project lookup entirely — no
  // reassignment, the FK already points there, so re-validating is pointless and a
  // wasted query. We assert lookup.calls === 0 to lock that contract in.

  it('(f) customer task already on a FLAGGED project; resubmit SAME projectId + other fields → no error', async () => {
    // The project got flagged network AFTER the task was attached. Editing the
    // due date must NOT trip the kind guard because the projectId is unchanged.
    const lookup = new StubProjectKindLookup({ 'proj-flagged': true });
    const { repo, useCase } = buildUseCase(lookup);
    const id = await seedTask(repo, 'customer', 'proj-flagged');
    const updated = await useCase.execute(id, { projectId: 'proj-flagged', title: 'new due date' } as never);
    expect(updated?.title).toBe('new due date');
    expect(updated?.projectId).toBe('proj-flagged');
    expect(lookup.calls).toBe(0); // same-id no-op: no lookup, no guard
  });

  it('(g) network task already on an UNFLAGGED project; resubmit SAME projectId → no error', async () => {
    const lookup = new StubProjectKindLookup({ 'proj-unflagged': false });
    const { repo, useCase } = buildUseCase(lookup);
    const id = await seedTask(repo, 'network', 'proj-unflagged');
    const updated = await useCase.execute(id, { projectId: 'proj-unflagged', title: 'edited' } as never);
    expect(updated?.title).toBe('edited');
    expect(updated?.projectId).toBe('proj-unflagged');
    expect(lookup.calls).toBe(0); // same-id no-op: no lookup, no guard
  });

  it('(h) regression: REASSIGN to a DIFFERENT flagged project (customer kind) → still ProjectKindMismatchError', async () => {
    // Task currently on an unflagged project; moving it to a DIFFERENT flagged
    // project is a real reassignment → the guard must still fire.
    const lookup = new StubProjectKindLookup({ 'proj-old': false, 'proj-new-network': true });
    const { repo, useCase } = buildUseCase(lookup);
    const id = await seedTask(repo, 'customer', 'proj-old');
    await expect(
      useCase.execute(id, { projectId: 'proj-new-network' } as never),
    ).rejects.toBeInstanceOf(ProjectKindMismatchError);
  });

  it('(i) regression: clearing projectId to null is unchanged (no lookup, no guard)', async () => {
    const lookup = new StubProjectKindLookup({ 'proj-flagged': true });
    const { repo, useCase } = buildUseCase(lookup);
    const id = await seedTask(repo, 'customer', 'proj-flagged');
    const updated = await useCase.execute(id, { projectId: null } as never);
    expect(updated?.projectId).toBeNull();
    expect(lookup.calls).toBe(0); // null clear never touches the project lookup
  });
});
