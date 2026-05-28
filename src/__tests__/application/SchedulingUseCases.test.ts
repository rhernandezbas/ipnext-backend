import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { ListTasks } from '../../application/use-cases/ListTasks';
import { GetTask } from '../../application/use-cases/GetTask';
import { CreateTask } from '../../application/use-cases/CreateTask';
import { EntityLookup } from '../../domain/ports/EntityLookup';

class StubLookup implements EntityLookup {
  async findById(_id: string) { return null; }
}
const emptyLookup = new StubLookup();

// Default stage IDs used by InMemorySchedulingRepository — valid UUID format
const DEFAULT_STAGE_ID_PENDING = '10000000-0000-4000-a000-000000000001';

function makeRepo() {
  return new InMemorySchedulingRepository();
}

describe('ListTasks', () => {
  it('returns 7 seeded tasks', async () => {
    const repo = makeRepo();
    const uc = new ListTasks(repo);

    const result = await uc.execute();

    expect(result).toHaveLength(7);
    expect(result.every(t => t.id && t.title && t.stageId)).toBe(true);
  });
});

describe('GetTask', () => {
  it('returns correct task by id', async () => {
    const repo = makeRepo();
    const uc = new GetTask(repo);

    const result = await uc.execute('1');

    expect(result).not.toBeNull();
    expect(result!.id).toBe('1');
    expect(result!.title).toBe('Instalación fibra óptica - García');
    expect(result!.category).toBe('installation');
  });
});

describe('CreateTask', () => {
  it('creates task with stageId and stageCategory', async () => {
    const repo = makeRepo();
    const uc = new CreateTask(repo, emptyLookup, emptyLookup, emptyLookup, emptyLookup, emptyLookup);

    const result = await uc.execute({
      title: 'Nueva tarea de prueba',
      description: 'Descripción de prueba',
      stageId: DEFAULT_STAGE_ID_PENDING,
      priority: 'normal',
      estimatedHours: 2,
      address: 'Calle Test 123',
      coordinates: null,
      category: 'other',
      completedAt: null,
      notes: '',
      startDate: null,
      endDate: null,
      customerId: null,
      serviceId: null,
      partnerId: null,
      reporterId: null,
      assigneeId: null,
      watcherIds: [],
      travelTimeTo: null,
      travelTimeFrom: null,
    });

    expect(result.id).toBeTruthy();
    expect(result.title).toBe('Nueva tarea de prueba');
    expect(result.stageId).toBe(DEFAULT_STAGE_ID_PENDING);
    expect(result.stageCategory).toBe('nuevo');
  });
});
