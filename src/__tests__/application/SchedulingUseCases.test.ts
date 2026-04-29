import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { ListTasks } from '../../application/use-cases/ListTasks';
import { GetTask } from '../../application/use-cases/GetTask';
import { CreateTask } from '../../application/use-cases/CreateTask';
import { UpdateTaskStatus } from '../../application/use-cases/UpdateTaskStatus';

function makeRepo() {
  return new InMemorySchedulingRepository();
}

describe('ListTasks', () => {
  it('returns 6 seeded tasks', async () => {
    const repo = makeRepo();
    const uc = new ListTasks(repo);

    const result = await uc.execute();

    expect(result).toHaveLength(6);
    expect(result.every(t => t.id && t.title && t.status)).toBe(true);
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
  it('creates task with status pending', async () => {
    const repo = makeRepo();
    const uc = new CreateTask(repo);

    const result = await uc.execute({
      title: 'Nueva tarea de prueba',
      description: 'Descripción de prueba',
      assignedTo: 'Técnico Test',
      assignedToId: 'admin-99',
      clientId: null,
      clientName: null,
      status: 'pending',
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
    expect(result.status).toBe('pending');
  });
});

describe('UpdateTaskStatus', () => {
  it('changes task status to in_progress', async () => {
    const repo = makeRepo();
    const uc = new UpdateTaskStatus(repo);

    const result = await uc.execute('1', 'in_progress');

    expect(result).not.toBeNull();
    expect(result!.id).toBe('1');
    expect(result!.status).toBe('in_progress');
  });
});
