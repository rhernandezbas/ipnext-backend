import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { ListTasks } from '../../application/use-cases/ListTasks';
import { GetTask } from '../../application/use-cases/GetTask';
import { CreateTask } from '../../application/use-cases/CreateTask';
import { UpdateTaskStatus } from '../../application/use-cases/UpdateTaskStatus';

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
    const uc = new CreateTask(repo);

    const result = await uc.execute({
      title: 'Nueva tarea de prueba',
      description: 'Descripción de prueba',
      assignedTo: 'Técnico Test',
      assignedToId: 'admin-99',
      clientId: null,
      clientName: null,
      stageId: DEFAULT_STAGE_ID_PENDING,
      priority: 'normal',
      scheduledDate: '2026-05-10',
      scheduledTime: '10:00',
      estimatedHours: 2,
      address: 'Calle Test 123',
      coordinates: null,
      category: 'other',
      completedAt: null,
      notes: '',
    });

    expect(result.id).toBeTruthy();
    expect(result.title).toBe('Nueva tarea de prueba');
    expect(result.stageId).toBe(DEFAULT_STAGE_ID_PENDING);
    expect(result.stageCategory).toBe('nuevo');
    expect(result.status).toBe('pending');
  });
});

describe('UpdateTaskStatus', () => {
  it('changes task status to in_progress via deprecated shim', async () => {
    const repo = makeRepo();
    const { InMemoryStageRepository } = require('../../infrastructure/adapters/in-memory/InMemoryStageRepository');
    const stageRepo = new InMemoryStageRepository();
    // Add default stages for legacy mapping
    stageRepo.addDirect({ id: '10000000-0000-4000-a000-000000000001', workflowId: 'wf', name: 'Nuevo',            category: 'nuevo',      order: 0 });
    stageRepo.addDirect({ id: '10000000-0000-4000-a000-000000000002', workflowId: 'wf', name: 'En progreso',       category: 'enProgreso', order: 7 });
    stageRepo.addDirect({ id: '10000000-0000-4000-a000-000000000003', workflowId: 'wf', name: 'Hecho',             category: 'hecho',      order: 9 });
    stageRepo.addDirect({ id: '10000000-0000-4000-a000-000000000004', workflowId: 'wf', name: 'Anulado-Cancelado', category: 'hecho',      order: 10 });
    const uc = new UpdateTaskStatus(repo, stageRepo);

    const result = await uc.execute('1', 'in_progress');

    expect(result).not.toBeNull();
    expect(result!.id).toBe('1');
    expect(result!.status).toBe('in_progress');
    expect(result!.stageCategory).toBe('enProgreso');
  });
});
