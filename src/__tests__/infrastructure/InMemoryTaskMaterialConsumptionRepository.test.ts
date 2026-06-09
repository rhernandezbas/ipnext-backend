import { InMemoryTaskMaterialConsumptionRepository } from '@infrastructure/adapters/in-memory/InMemoryTaskMaterialConsumptionRepository';
import { TaskMaterialConsumption } from '@domain/entities/task-material-consumption';

function makeConsumption(overrides: Partial<TaskMaterialConsumption> = {}): TaskMaterialConsumption {
  return {
    id: 'cons-1',
    taskId: 'task-1',
    materialCatalogId: 'mat-1',
    materialName: 'CABLE_UTP',
    quantity: 10,
    unit: 'm',
    notes: null,
    recordedByUserId: null,
    deductedAt: null,
    deductedMovementId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('InMemoryTaskMaterialConsumptionRepository', () => {
  let repo: InMemoryTaskMaterialConsumptionRepository;

  beforeEach(() => {
    repo = new InMemoryTaskMaterialConsumptionRepository();
  });

  it('create stores a consumption and returns it', async () => {
    const c = makeConsumption();
    const result = await repo.create(c);
    expect(result.id).toBe('cons-1');
    expect(result.materialName).toBe('CABLE_UTP');
  });

  it('listByTask returns only consumptions for the given task', async () => {
    await repo.create(makeConsumption({ id: 'cons-1', taskId: 'task-1' }));
    await repo.create(makeConsumption({ id: 'cons-2', taskId: 'task-2' }));
    await repo.create(makeConsumption({ id: 'cons-3', taskId: 'task-1' }));

    const result = await repo.listByTask('task-1');
    expect(result).toHaveLength(2);
    expect(result.map(r => r.id)).toContain('cons-1');
    expect(result.map(r => r.id)).toContain('cons-3');
  });

  it('listByTask returns empty array for unknown task', async () => {
    const result = await repo.listByTask('nonexistent');
    expect(result).toHaveLength(0);
  });

  it('delete removes the consumption and returns true; unknown id returns false', async () => {
    const c = makeConsumption({ id: 'cons-1' });
    await repo.create(c);

    expect(await repo.delete('cons-1')).toBe(true);
    expect(await repo.listByTask('task-1')).toHaveLength(0);
    expect(await repo.delete('nonexistent')).toBe(false);
  });
});
