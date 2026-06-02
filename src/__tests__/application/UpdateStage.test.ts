import { InMemoryStageRepository } from '@infrastructure/adapters/in-memory/InMemoryStageRepository';
import { UpdateStage } from '@application/use-cases/UpdateStage';
import { StageNotFoundError, StageNameConflictError } from '@domain/errors/scheduling';

describe('UpdateStage', () => {
  it('updates the name of an existing stage', async () => {
    const repo = new InMemoryStageRepository();
    const stage = await repo.add('wf-1', { name: 'Viejo', code: 'viejo', category: 'nuevo', order: 0 });
    const uc = new UpdateStage(repo);

    const updated = await uc.execute(stage.id, { name: 'Nuevo nombre' });

    expect(updated.name).toBe('Nuevo nombre');
    expect(updated.code).toBe('viejo'); // code NUNCA cambia
    expect((await repo.getById(stage.id))?.name).toBe('Nuevo nombre');
  });

  it('updates the category of an existing stage', async () => {
    const repo = new InMemoryStageRepository();
    const stage = await repo.add('wf-1', { name: 'Tarea', code: 'tarea', category: 'nuevo', order: 0 });
    const uc = new UpdateStage(repo);

    const updated = await uc.execute(stage.id, { category: 'hecho' });

    expect(updated.category).toBe('hecho');
    expect(updated.code).toBe('tarea'); // code NUNCA cambia
  });

  it('updates both name and category in the same call', async () => {
    const repo = new InMemoryStageRepository();
    const stage = await repo.add('wf-1', { name: 'Draft', code: 'draft', category: 'nuevo', order: 0 });
    const uc = new UpdateStage(repo);

    const updated = await uc.execute(stage.id, { name: 'En Curso', category: 'enProgreso' });

    expect(updated.name).toBe('En Curso');
    expect(updated.category).toBe('enProgreso');
    expect(updated.code).toBe('draft');
  });

  it('does NOT change code, order, or color — only name/category fields are mutable', async () => {
    const repo = new InMemoryStageRepository();
    const stage = await repo.add('wf-1', { name: 'Original', code: 'orig', category: 'nuevo', order: 3 });
    const uc = new UpdateStage(repo);

    const updated = await uc.execute(stage.id, { name: 'Cambiado' });

    expect(updated.name).toBe('Cambiado');
    expect(updated.code).toBe('orig');  // code inmutable
    expect(updated.order).toBe(3);      // order no cambia en este UC
  });

  it('throws StageNotFoundError for an unknown stage', async () => {
    const repo = new InMemoryStageRepository();
    const uc = new UpdateStage(repo);

    await expect(uc.execute('non-existent', { name: 'X' })).rejects.toBeInstanceOf(StageNotFoundError);
  });

  it('throws StageNameConflictError when name is already taken in the same workflow', async () => {
    const repo = new InMemoryStageRepository();
    await repo.add('wf-1', { name: 'Tomado', code: 'tomado', category: 'hecho', order: 0 });
    const stage = await repo.add('wf-1', { name: 'Libre', code: 'libre', category: 'nuevo', order: 1 });
    const uc = new UpdateStage(repo);

    await expect(uc.execute(stage.id, { name: 'Tomado' })).rejects.toBeInstanceOf(StageNameConflictError);
  });

  it('does NOT throw conflict when renaming to the same name (idempotent)', async () => {
    const repo = new InMemoryStageRepository();
    const stage = await repo.add('wf-1', { name: 'Mismo', code: 'mismo', category: 'nuevo', order: 0 });
    const uc = new UpdateStage(repo);

    await expect(uc.execute(stage.id, { name: 'Mismo' })).resolves.toBeDefined();
  });

  it('allows the same name in a different workflow (no conflict)', async () => {
    const repo = new InMemoryStageRepository();
    await repo.add('wf-2', { name: 'Duplicado', code: 'dup', category: 'hecho', order: 0 });
    const stage = await repo.add('wf-1', { name: 'Local', code: 'local', category: 'nuevo', order: 0 });
    const uc = new UpdateStage(repo);

    await expect(uc.execute(stage.id, { name: 'Duplicado' })).resolves.toBeDefined();
  });
});
