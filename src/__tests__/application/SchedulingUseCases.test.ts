import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { ListTasks } from '../../application/use-cases/ListTasks';
import { GetTask } from '../../application/use-cases/GetTask';
import { CreateTask } from '../../application/use-cases/CreateTask';
import { EntityLookup } from '../../domain/ports/EntityLookup';

class StubLookup implements EntityLookup {
  async findById(_id: string) { return null; }
}
const emptyLookup = new StubLookup();

// Accepts any ID — used for required FKs where identity is not under test
class AnyLookup implements EntityLookup {
  async findById(id: string) { return { id, isNetworkProject: false }; }
}
const anyLookup = new AnyLookup();

const DEFAULT_CUSTOMER_ID = 'customer-default-0000-000000000001';
const DEFAULT_CONTRACT_ID = 'contract-default-00000-000000000001';

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
    // REQ-REQUIRED-1/2: customer and service lookups must accept the provided IDs
    const uc = new CreateTask(repo, anyLookup, anyLookup, emptyLookup, emptyLookup, emptyLookup);

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
      // REQ-REQUIRED-1/2: required on create
      customerId: DEFAULT_CUSTOMER_ID,
      contractId: DEFAULT_CONTRACT_ID,
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
