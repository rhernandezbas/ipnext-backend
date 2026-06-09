import { ListTaskMaterialConsumptions } from '@application/use-cases/ListTaskMaterialConsumptions';
import { InMemoryTaskMaterialConsumptionRepository } from '@infrastructure/adapters/in-memory/InMemoryTaskMaterialConsumptionRepository';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { TaskMaterialConsumption } from '@domain/entities/task-material-consumption';

const makeConsumption = (over: Partial<TaskMaterialConsumption>): TaskMaterialConsumption => ({
  id: 'c1',
  taskId: 't1',
  materialCatalogId: 'm1',
  materialName: 'CABLE_UTP',
  quantity: 5,
  unit: 'm',
  notes: null,
  recordedByUserId: null,
  deductedAt: null,
  deductedMovementId: null,
  createdAt: '2026-06-01T00:00:00Z',
  updatedAt: '2026-06-01T00:00:00Z',
  ...over,
});

describe('ListTaskMaterialConsumptions', () => {
  it('returns consumptions scoped to the given taskId', async () => {
    const repo = new InMemoryTaskMaterialConsumptionRepository();
    const users = new InMemoryRbacUserRepository();
    const useCase = new ListTaskMaterialConsumptions(repo, users);

    await repo.create(makeConsumption({ id: 'c1', taskId: 't1' }));
    await repo.create(makeConsumption({ id: 'c2', taskId: 't2' }));

    const result = await useCase.execute('t1');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('c1');
  });

  it('resolves recordedByUserName when user exists', async () => {
    const repo = new InMemoryTaskMaterialConsumptionRepository();
    const users = new InMemoryRbacUserRepository();
    const user = await users.create({ name: 'Ana García', email: 'ana@x.com', login: 'ana', passwordHash: 'h' });
    const useCase = new ListTaskMaterialConsumptions(repo, users);

    await repo.create(makeConsumption({ id: 'c1', taskId: 't1', recordedByUserId: user.id }));
    const result = await useCase.execute('t1');
    expect(result[0].recordedByUserName).toBe('Ana García');
  });

  it('recordedByUserName is null when no user', async () => {
    const repo = new InMemoryTaskMaterialConsumptionRepository();
    const users = new InMemoryRbacUserRepository();
    const useCase = new ListTaskMaterialConsumptions(repo, users);

    await repo.create(makeConsumption({ id: 'c1', taskId: 't1', recordedByUserId: null }));
    const result = await useCase.execute('t1');
    expect(result[0].recordedByUserName).toBeNull();
  });

  it('returns empty array when no consumptions for task', async () => {
    const repo = new InMemoryTaskMaterialConsumptionRepository();
    const users = new InMemoryRbacUserRepository();
    const useCase = new ListTaskMaterialConsumptions(repo, users);
    const result = await useCase.execute('t1');
    expect(result).toHaveLength(0);
  });
});
