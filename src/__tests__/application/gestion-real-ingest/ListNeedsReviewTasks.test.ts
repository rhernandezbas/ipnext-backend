import { ListNeedsReviewTasks } from '@application/use-cases/ListNeedsReviewTasks';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { CreateTaskInput } from '@domain/ports/SchedulingRepository';

const DEFAULT_STAGE_ID = '10000000-0000-4000-a000-000000000001';

function taskInput(overrides: Partial<CreateTaskInput>): CreateTaskInput {
  return {
    title: 'Instalación',
    description: null,
    stageId: DEFAULT_STAGE_ID,
    priority: 'normal',
    estimatedHours: 1,
    address: null,
    coordinates: null,
    category: 'installation',
    projectId: null,
    projectName: null,
    completedAt: null,
    notes: null,
    startDate: null,
    endDate: null,
    customerId: null,
    contractId: null,
    partnerId: null,
    reporterId: null,
    assigneeId: null,
    travelTimeTo: null,
    travelTimeFrom: null,
    grOrdenId: null,
    ...overrides,
  };
}

describe('ListNeedsReviewTasks', () => {
  it('REQ-REVIEW-1: returns only the needs-review tasks (no project + grOrdenId set)', async () => {
    const scheduling = new InMemorySchedulingRepository();
    // Needs-review task: ingested (grOrdenId), unclassified (no project).
    await scheduling.createTask(
      taskInput({
        title: '[REVISAR - Logística] Instalación Acme',
        description: 'Plan no reconocido — asignar tecnología y proyecto manualmente',
        projectId: null,
        grOrdenId: 'gr-ord-1',
      }),
    );
    // Normal fiber task: ingested but classified (has project) — must be excluded.
    await scheduling.createTask(
      taskInput({
        title: 'Instalación Bob',
        projectId: 'p-fiber',
        grOrdenId: 'gr-ord-2',
      }),
    );

    const useCase = new ListNeedsReviewTasks(scheduling);
    const result = await useCase.execute();

    expect(result).toHaveLength(1);
    expect(result[0]!.grOrdenId).toBe('gr-ord-1');
    expect(result[0]!.projectId).toBeNull();
    expect(result[0]!.title).toContain('[REVISAR - Logística]');
  });

  it('REQ-REVIEW-1: returns an empty array when nothing needs review', async () => {
    const scheduling = new InMemorySchedulingRepository();
    const useCase = new ListNeedsReviewTasks(scheduling);

    const result = await useCase.execute();

    expect(result).toEqual([]);
  });
});
