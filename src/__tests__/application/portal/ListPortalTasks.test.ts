/**
 * customer-portal-api (Fase 4, task 4.4) — ListPortalTasks.
 *
 * portal-self-service spec "Mis tareas — visitas con estado publico". Usa el
 * InMemorySchedulingRepository COMPARTIDO (adapter real, no un fake nuevo — el
 * mismo puerto que consume ListTasks admin) y sus sentinel stage ids ya
 * establecidos como patron de test en el repo (scheduling.routes.test.ts,
 * scheduling.isClosed.test.ts, ...): PENDING(...001)=nuevo, IN_PROGRESS(...002)=
 * enProgreso, COMPLETED(...003)=hecho.
 */
import { ListPortalTasks } from '@application/use-cases/portal/ListPortalTasks';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';

const STAGE_NUEVO = '10000000-0000-4000-a000-000000000001';
const STAGE_EN_PROGRESO = '10000000-0000-4000-a000-000000000002';
const STAGE_HECHO = '10000000-0000-4000-a000-000000000003';

describe('ListPortalTasks — customer-portal-api Fase 4.4', () => {
  it('scenario "Cliente con visita programada": ve fecha, franja y "agendada" — nada mas', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({
      id: 'task-a',
      customerId: 'client-a',
      stageId: STAGE_NUEVO,
      startDate: '2026-08-01T09:00:00-03:00',
      // campos internos que el DTO NUNCA debe exponer
      assigneeName: 'Tecnico Juan',
      notes: 'nota interna sensible',
    });
    const useCase = new ListPortalTasks(repo);

    const result = await useCase.execute('client-a');

    expect(result).toEqual([
      { scheduledDate: '2026-08-01T09:00:00-03:00', franja: 'mañana', publicStatus: 'agendada' },
    ]);
  });

  it('mapea en_curso / completada / cancelada segun stage + generalStatus', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 't-progreso', customerId: 'client-a', stageId: STAGE_EN_PROGRESO, startDate: '2026-08-02T15:00:00-03:00' });
    repo.seedTask({ id: 't-hecho', customerId: 'client-a', stageId: STAGE_HECHO, generalStatus: 'closed', startDate: '2026-08-03T10:00:00-03:00' });
    repo.seedTask({ id: 't-cancelada', customerId: 'client-a', stageId: STAGE_HECHO, generalStatus: 'dismissed', startDate: '2026-08-04T10:00:00-03:00' });
    const useCase = new ListPortalTasks(repo);

    const result = await useCase.execute('client-a');
    const byDate = new Map(result.map((t) => [t.scheduledDate, t.publicStatus]));

    expect(byDate.get('2026-08-02T15:00:00-03:00')).toBe('en_curso');
    expect(byDate.get('2026-08-03T10:00:00-03:00')).toBe('completada');
    expect(byDate.get('2026-08-04T10:00:00-03:00')).toBe('cancelada');
  });

  it('sin startDate -> scheduledDate y franja null, no revienta', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 't-sin-fecha', customerId: 'client-a', stageId: STAGE_NUEVO, startDate: null });
    const useCase = new ListPortalTasks(repo);

    const result = await useCase.execute('client-a');

    expect(result).toEqual([{ scheduledDate: null, franja: null, publicStatus: 'agendada' }]);
  });

  it('el DTO no expone tecnico/notas/materiales/nombre crudo del stage', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 'task-a', customerId: 'client-a', stageId: STAGE_NUEVO, assigneeName: 'Tecnico Juan', notes: 'nota interna' });
    const useCase = new ListPortalTasks(repo);

    const result = await useCase.execute('client-a');
    const dto = result[0] as unknown as Record<string, unknown>;

    expect(dto['assigneeName']).toBeUndefined();
    expect(dto['notes']).toBeUndefined();
    expect(dto['stageId']).toBeUndefined();
    expect(dto['stageCategory']).toBeUndefined();
  });

  it('anti-IDOR: dos clientes seedeados, cada llamada ve SOLO sus propias tareas', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 'task-a', customerId: 'client-a', stageId: STAGE_NUEVO, startDate: '2026-08-01T09:00:00-03:00' });
    repo.seedTask({ id: 'task-b1', customerId: 'client-b', stageId: STAGE_NUEVO, startDate: '2026-08-05T09:00:00-03:00' });
    repo.seedTask({ id: 'task-b2', customerId: 'client-b', stageId: STAGE_HECHO, startDate: '2026-08-06T09:00:00-03:00' });
    const useCase = new ListPortalTasks(repo);

    const a = await useCase.execute('client-a');
    const b = await useCase.execute('client-b');

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);
  });
});
