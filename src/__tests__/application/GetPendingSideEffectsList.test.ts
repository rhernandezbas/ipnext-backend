import { InMemoryClosedServiceOrderRepository } from '../../infrastructure/adapters/in-memory/InMemoryClosedServiceOrderRepository';
import { GetPendingSideEffectsList } from '../../application/use-cases/GetPendingSideEffectsList';
import type { ClosedServiceOrder } from '../../domain/entities/iclass-closed-order';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSO(iclassId: string): ClosedServiceOrder {
  return {
    iclassId,
    iclassCodigo: iclassId,
    iclassUpdatedAt: '2024-01-01',
    clusterName: 'cluster',
    thirdPartyCode: null, nodeCode: null, soTypeId: null, soTypeDescription: null,
    customerCode: null, customerName: null, addressCode: null, addressLine: null,
    addressCity: null, addressLat: null, addressLng: null,
    statusCode: '7', statusDescription: 'Encerrado',
    requestedAt: null, scheduledFor: null, availableAt: null,
    serviceStartedAt: null, serviceEndedAt: null,
    resultCodeName: null, closedByLogin: null, closedByName: null,
    closeLatitude: null, closeLongitude: null, closeGpsAt: null,
    billingAmount: null, technicianNote: null, internalNote: null, commentaryLog: null,
    teamLogin: null, teamTechnicianName: null, teamPhone: null, teamEmail: null,
    iclassCreatedAt: null, rawDetail: {},
    closedAt: null, firstClosedAt: null, approvedAt: null, resultCodeType: null,
    history: [], checklists: [], materials: [], equipmentEvents: [],
  };
}

// ---------------------------------------------------------------------------
// REQ-LIST-2 SC1: Use case maps port result to DTO
// iclass-closure-loop SC1: Port returns items with joined task
// ---------------------------------------------------------------------------

describe('GetPendingSideEffectsList', () => {
  it('returns {items, total} with 2 items: one with task, one without', async () => {
    const tasks = new Map([
      ['task-1', { id: 'task-1', sequenceNumber: 42, title: 'Instalación fibra' }],
    ]);
    const repo = new InMemoryClosedServiceOrderRepository(tasks);

    // SO with linked task (task-1 exists in the tasks Map)
    await repo.upsert(makeSO('so-with-task'), 'task-1');
    // SO with no linked task (scheduledTaskId = null)
    await repo.upsert(makeSO('so-no-task'), null);

    const useCase = new GetPendingSideEffectsList(repo);
    const result = await useCase.execute();

    expect(result.total).toBe(2);
    expect(result.items).toHaveLength(2);

    const withTask = result.items.find(i => i.iclassId === 'so-with-task');
    expect(withTask).toBeDefined();
    expect(withTask!.task).toEqual({ id: 'task-1', sequenceNumber: 42, title: 'Instalación fibra' });

    const noTask = result.items.find(i => i.iclassId === 'so-no-task');
    expect(noTask).toBeDefined();
    expect(noTask!.task).toBeNull();
    expect(noTask!.scheduledTaskId).toBeNull();
  });

  // REQ-LIST-2 SC1 — total === items.length invariant
  it('total always equals items.length', async () => {
    const tasks = new Map([
      ['t-a', { id: 't-a', sequenceNumber: 1, title: 'Task A' }],
      ['t-b', { id: 't-b', sequenceNumber: 2, title: 'Task B' }],
      ['t-c', { id: 't-c', sequenceNumber: 3, title: 'Task C' }],
    ]);
    const repo = new InMemoryClosedServiceOrderRepository(tasks);
    await repo.upsert(makeSO('so-1'), 't-a');
    await repo.upsert(makeSO('so-2'), 't-b');
    await repo.upsert(makeSO('so-3'), 't-c');

    const useCase = new GetPendingSideEffectsList(repo);
    const result = await useCase.execute();

    expect(result.total).toBe(result.items.length);
    expect(result.total).toBe(3);
  });

  // iclass-closure-loop SC2: empty when nothing pending
  it('returns {items:[], total:0} when nothing pending', async () => {
    const repo = new InMemoryClosedServiceOrderRepository();
    const useCase = new GetPendingSideEffectsList(repo);
    const result = await useCase.execute();

    expect(result.total).toBe(0);
    expect(result.items).toHaveLength(0);
  });

  // F1 — dismissed tasks must NOT appear in the FE progress table (their side-effects
  // are intentionally not reprocessed). Excluded at the repo level so list+count agree.
  it('excludes SOs whose linked task is dismissed', async () => {
    const tasks = new Map([
      ['t-open', { id: 't-open', sequenceNumber: 1, title: 'Open', generalStatus: 'open' as const }],
      ['t-dismissed', { id: 't-dismissed', sequenceNumber: 2, title: 'Dismissed', generalStatus: 'dismissed' as const }],
    ]);
    const repo = new InMemoryClosedServiceOrderRepository(tasks);
    await repo.upsert(makeSO('so-open'), 't-open');
    await repo.upsert(makeSO('so-dismissed'), 't-dismissed');
    await repo.upsert(makeSO('so-no-task'), null); // null task is kept (not dismissed)

    const result = await new GetPendingSideEffectsList(repo).execute();

    const ids = result.items.map(i => i.iclassId).sort();
    expect(ids).toEqual(['so-no-task', 'so-open']);
    expect(result.total).toBe(2);
  });

  // iclass-closure-loop SC3: existing listPendingSideEffects is unchanged
  it('existing listPendingSideEffects still returns original shape unmodified', async () => {
    const tasks = new Map([
      ['task-x', { id: 'task-x', sequenceNumber: 99, title: 'Task X' }],
    ]);
    const repo = new InMemoryClosedServiceOrderRepository(tasks);
    await repo.upsert(makeSO('so-x'), 'task-x');

    const legacy = await repo.listPendingSideEffects(3);
    expect(legacy).toHaveLength(1);
    expect(legacy[0]).toEqual({
      iclassId: 'so-x',
      scheduledTaskId: 'task-x',
      commentPosted: false,
      inventoryBuilt: false,
      auditDone: false,
      auditAttempts: 0,
      inventoryReturnsProcessed: false,
    });
    // Must NOT have a `task` field — legacy shape is unchanged
    expect((legacy[0] as unknown as Record<string, unknown>)['task']).toBeUndefined();
  });
});
