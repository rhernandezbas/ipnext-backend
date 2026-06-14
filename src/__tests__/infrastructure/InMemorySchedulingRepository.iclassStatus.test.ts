/**
 * Tests for InMemorySchedulingRepository.setIClassStatus and iclassStatus resolution.
 * Verifies that:
 * 1. setIClassStatus persists code + at on the task
 * 2. The task read-path resolves iclassStatus by catalog lookup (label/color/tracked)
 * 3. iclassStatus is null when no code or no matching catalog entry
 */
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryIClassStatusCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryIClassStatusCatalogRepository';

describe('InMemorySchedulingRepository — setIClassStatus + iclassStatus resolution', () => {
  function makeRepo(statusCatalog?: InMemoryIClassStatusCatalogRepository) {
    return new InMemorySchedulingRepository(undefined, undefined, statusCatalog);
  }

  it('setIClassStatus persists the statusCode on the task', async () => {
    const repo = makeRepo();
    const task = repo.seedTask({ id: 't1' });
    const at = new Date('2026-06-01T10:00:00Z');
    await repo.setIClassStatus(task.id, '7', at);

    const found = await repo.getTask(task.id);
    expect(found).not.toBeNull();
    expect(found!.iclassStatusCode).toBe('7');
    expect(found!.iclassStatusUpdatedAt).toBe(at.toISOString());
  });

  it('iclassStatus is null when task has no iclassStatusCode', async () => {
    const catalog = new InMemoryIClassStatusCatalogRepository();
    await catalog.upsertByStatusCode({ statusCode: '7', iclassLabel: 'Concluida' });
    const repo = makeRepo(catalog);
    repo.seedTask({ id: 't2' });

    const found = await repo.getTask('t2');
    expect(found!.iclassStatus).toBeNull();
  });

  it('resolves iclassStatus from catalog using effectiveLabel (displayLabel when set)', async () => {
    const catalog = new InMemoryIClassStatusCatalogRepository();
    await catalog.upsertByStatusCode({ statusCode: '7', iclassLabel: 'Concluida' });
    await catalog.update('7', { displayLabel: 'Cerrada', color: '#00FF00', tracked: true });

    const repo = makeRepo(catalog);
    repo.seedTask({ id: 't3' });
    await repo.setIClassStatus('t3', '7', new Date());

    const found = await repo.getTask('t3');
    expect(found!.iclassStatus).toEqual({
      code: '7',
      label: 'Cerrada',
      color: '#00FF00',
      tracked: true,
    });
  });

  it('resolves iclassStatus using iclassLabel when displayLabel is null', async () => {
    const catalog = new InMemoryIClassStatusCatalogRepository();
    await catalog.upsertByStatusCode({ statusCode: '3', iclassLabel: 'Agendada' });

    const repo = makeRepo(catalog);
    repo.seedTask({ id: 't4' });
    await repo.setIClassStatus('t4', '3', new Date());

    const found = await repo.getTask('t4');
    expect(found!.iclassStatus).toEqual({
      code: '3',
      label: 'Agendada',
      color: null,
      tracked: false,
    });
  });

  it('iclassStatus is null when code is set but catalog has no matching entry', async () => {
    const catalog = new InMemoryIClassStatusCatalogRepository();
    const repo = makeRepo(catalog);
    repo.seedTask({ id: 't5' });
    await repo.setIClassStatus('t5', '999', new Date());

    const found = await repo.getTask('t5');
    expect(found!.iclassStatusCode).toBe('999');
    expect(found!.iclassStatus).toBeNull();
  });

  it('setIClassStatus is a no-op when task does not exist', async () => {
    const repo = makeRepo();
    // Should NOT throw
    await expect(repo.setIClassStatus('non-existent-id', '7', new Date())).resolves.toBeUndefined();
  });
});
