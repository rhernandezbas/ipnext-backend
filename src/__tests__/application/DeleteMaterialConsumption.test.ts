import { DeleteMaterialConsumption } from '@application/use-cases/DeleteMaterialConsumption';
import { InMemoryTaskMaterialConsumptionRepository } from '@infrastructure/adapters/in-memory/InMemoryTaskMaterialConsumptionRepository';
import { TaskMaterialConsumption } from '@domain/entities/task-material-consumption';

const makeConsumption = (id: string): TaskMaterialConsumption => ({
  id,
  taskId: 't1',
  materialCatalogId: 'm1',
  materialName: 'CABLE_UTP',
  quantity: 5,
  unit: 'm',
  notes: null,
  recordedByUserId: null,
  createdAt: '2026-06-01T00:00:00Z',
  updatedAt: '2026-06-01T00:00:00Z',
});

describe('DeleteMaterialConsumption', () => {
  it('deletes an existing consumption', async () => {
    const repo = new InMemoryTaskMaterialConsumptionRepository();
    const useCase = new DeleteMaterialConsumption(repo);
    await repo.create(makeConsumption('c1'));
    await useCase.execute('c1');
    const remaining = await repo.listByTask('t1');
    expect(remaining).toHaveLength(0);
  });

  it('throws MaterialConsumptionNotFoundError when consumption does not exist', async () => {
    const repo = new InMemoryTaskMaterialConsumptionRepository();
    const useCase = new DeleteMaterialConsumption(repo);
    await expect(useCase.execute('nonexistent'))
      .rejects.toMatchObject({ code: 'MATERIAL_CONSUMPTION_NOT_FOUND' });
  });
});
