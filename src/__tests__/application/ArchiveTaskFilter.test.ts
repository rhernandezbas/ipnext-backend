/**
 * TDD — #86 listTasks archived filter.
 *
 * Default (omitted): excludes archived tasks.
 * archived=true: includes only archived tasks.
 * archived=false: same as default.
 */
import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { ListTasks } from '../../application/use-cases/ListTasks';

const STAGE_ID = '10000000-0000-4000-a000-000000000001';

describe('ListTasks archived filter (#86)', () => {
  let repo: InMemorySchedulingRepository;
  let listTasks: ListTasks;

  beforeEach(() => {
    repo = new InMemorySchedulingRepository();
    listTasks = new ListTasks(repo);
  });

  it('default (omitted) excludes archived tasks', async () => {
    repo.seedTask({ id: 't-active', stageId: STAGE_ID, archivedAt: null });
    repo.seedTask({ id: 't-archived', stageId: STAGE_ID, generalStatus: 'closed', isClosed: true, archivedAt: new Date().toISOString() });

    const tasks = await listTasks.execute({});
    const ids = tasks.map(t => t.id);

    // The seeded fixtures (ids 1-7) in the repo are also returned by default.
    // We just verify our two tasks: active is included, archived is excluded.
    expect(ids).toContain('t-active');
    expect(ids).not.toContain('t-archived');
  });

  it('archived=false also excludes archived tasks', async () => {
    repo.seedTask({ id: 't-active2', stageId: STAGE_ID, archivedAt: null });
    repo.seedTask({ id: 't-archived2', stageId: STAGE_ID, generalStatus: 'closed', isClosed: true, archivedAt: new Date().toISOString() });

    const tasks = await listTasks.execute({ archived: false });
    const ids = tasks.map(t => t.id);

    expect(ids).toContain('t-active2');
    expect(ids).not.toContain('t-archived2');
  });

  it('archived=true returns only archived tasks', async () => {
    repo.seedTask({ id: 't-active3', stageId: STAGE_ID, archivedAt: null });
    repo.seedTask({ id: 't-archived3', stageId: STAGE_ID, generalStatus: 'closed', isClosed: true, archivedAt: new Date().toISOString() });

    const tasks = await listTasks.execute({ archived: true });
    const ids = tasks.map(t => t.id);

    expect(ids).toContain('t-archived3');
    expect(ids).not.toContain('t-active3');
    // The 7 default seeded fixtures have archivedAt: null, so they should not appear
    expect(tasks.every(t => t.archivedAt !== null)).toBe(true);
  });
});
