/**
 * TDD — PushIClassClosureOnTaskEnd.
 * STRICT TDD — tests written before implementation.
 *
 * When a task ends in Prominense (closed or dismissed), best-effort push the
 * matching close action to IClass so the field OS does not stay open forever.
 * NEVER throws — this is a fire-and-forget side effect of SetTaskGeneralStatus /
 * UpdateTask, and a failure here must never abort the local write that already succeeded.
 */
import { PushIClassClosureOnTaskEnd } from '@application/use-cases/PushIClassClosureOnTaskEnd';
import { InMemoryIClassClient } from '@infrastructure/adapters/in-memory/InMemoryIClassClient';
import { InMemoryFeatureFlagRepository } from '@infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { ScheduledTask } from '@domain/entities/scheduling';
import {
  ICLASS_COMPLETED_IN_PROMINENSE,
  ICLASS_CANCELLED_IN_PROMINENSE,
} from '@application/use-cases/iclassProminenseResultCodes';

const ORDER_CODE = 'OS-200';

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    sequenceNumber: 1,
    title: 'Task',
    description: null,
    stageId: 'stage-1',
    stageCategory: 'pending' as never,
    priority: 'normal',
    estimatedHours: 1,
    address: null,
    coordinates: null,
    category: 'other',
    projectId: null,
    projectName: null,
    completedAt: null,
    notes: null,
    startDate: null,
    endDate: null,
    customerId: null,
    customerName: null,
    customerCity: null,
    customerPhone: null,
    customerCode: null,
    contractId: null,
    contractCode: null,
    partnerId: null,
    reporterId: null,
    reporterName: null,
    assigneeId: null,
    assigneeName: null,
    watcherIds: [],
    travelTimeTo: null,
    travelTimeFrom: null,
    generalStatus: 'open',
    isClosed: false,
    closureOrigin: null,
    reviewedByInventory: false,
    reviewedByInventoryAt: null,
    reviewedByInventoryUserName: null,
    closureCommentDone: false,
    closureAuditDone: false,
    closureHasDeviceInventory: false,
    kind: 'customer',
    networkType: null,
    networkSiteId: null,
    networkSiteName: null,
    iclassCityCode: null,
    iclassOrderCode: ORDER_CODE,
    grOrdenId: null,
    ticketId: null,
    ticketSubject: null,
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as ScheduledTask;
}

function makeService() {
  const iclass = new InMemoryIClassClient();
  const flagRepo = new InMemoryFeatureFlagRepository();
  flagRepo.seed('iclass-close-action', true);
  const service = new PushIClassClosureOnTaskEnd(iclass, flagRepo);
  return { iclass, flagRepo, service };
}

describe('PushIClassClosureOnTaskEnd', () => {
  it('no-op when the feature flag is OFF', async () => {
    const { iclass, flagRepo, service } = makeService();
    flagRepo.seed('iclass-close-action', false);
    iclass.setServiceOrderSnapshot(ORDER_CODE, { iclassId: 'i1', iclassCodigo: ORDER_CODE, statusCode: '1', statusDescription: 'Aberta' });

    await service.execute(makeTask(), 'closed', 'Ana');

    expect(iclass.getGetServiceOrderCalls()).toHaveLength(0);
    expect(iclass.getCloseCalls()).toHaveLength(0);
  });

  it('no-op when the task has no iclassOrderCode', async () => {
    const { iclass, service } = makeService();

    await service.execute(makeTask({ iclassOrderCode: null }), 'closed', 'Ana');

    expect(iclass.getGetServiceOrderCalls()).toHaveLength(0);
    expect(iclass.getCloseCalls()).toHaveLength(0);
  });

  it('no-op when getServiceOrder returns null (IClass does not know this OS)', async () => {
    const { iclass, service } = makeService();
    iclass.setServiceOrderSnapshot(ORDER_CODE, null);

    await service.execute(makeTask(), 'closed', 'Ana');

    expect(iclass.getCloseCalls()).toHaveLength(0);
  });

  // IClass only lists SOs updated in the last 29 days: an older one is invisible here and
  // stays open in IClass forever, so the silence has to be audible somewhere.
  it('warns with the order code when IClass does not return the OS', async () => {
    const { iclass, service } = makeService();
    iclass.setServiceOrderSnapshot(ORDER_CODE, null);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await service.execute(makeTask(), 'closed', 'Ana');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain(ORDER_CODE);
    warn.mockRestore();
  });

  it("no-op when the snapshot statusCode is '7' (already terminal)", async () => {
    const { iclass, service } = makeService();
    iclass.setServiceOrderSnapshot(ORDER_CODE, { iclassId: 'i1', iclassCodigo: ORDER_CODE, statusCode: '7', statusDescription: 'Fechada' });

    await service.execute(makeTask(), 'closed', 'Ana');

    expect(iclass.getCloseCalls()).toHaveLength(0);
  });

  it("no-op when the snapshot statusCode is '50' (Aprovação — technician already closed it)", async () => {
    const { iclass, service } = makeService();
    iclass.setServiceOrderSnapshot(ORDER_CODE, { iclassId: 'i1', iclassCodigo: ORDER_CODE, statusCode: '50', statusDescription: 'Aprovação' });

    await service.execute(makeTask(), 'closed', 'Ana');

    expect(iclass.getCloseCalls()).toHaveLength(0);
  });

  it("outcome 'closed' → pushes COMPLETADA EN PROMINENSE, not visible to customer", async () => {
    const { iclass, service } = makeService();
    iclass.setServiceOrderSnapshot(ORDER_CODE, { iclassId: 'i1', iclassCodigo: ORDER_CODE, statusCode: '1', statusDescription: 'Aberta' });

    await service.execute(makeTask(), 'closed', 'Ana');

    const calls = iclass.getCloseCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.serviceOrderCode).toBe(ORDER_CODE);
    expect(calls[0]!.resultCode).toBe(ICLASS_COMPLETED_IN_PROMINENSE);
    expect(calls[0]!.commentary).toBe('Tarea cerrada en Prominense por Ana');
    expect(calls[0]!.visibleToCustomer).toBe(false);
  });

  it("outcome 'dismissed' → pushes CANCELADA EN PROMINENSE", async () => {
    const { iclass, service } = makeService();
    iclass.setServiceOrderSnapshot(ORDER_CODE, { iclassId: 'i1', iclassCodigo: ORDER_CODE, statusCode: '1', statusDescription: 'Aberta' });

    await service.execute(makeTask(), 'dismissed', 'Sistema');

    const calls = iclass.getCloseCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.resultCode).toBe(ICLASS_CANCELLED_IN_PROMINENSE);
    expect(calls[0]!.commentary).toBe('Tarea descartada en Prominense por Sistema');
  });

  it('never throws — closeServiceOrder failure is swallowed', async () => {
    const { iclass, service } = makeService();
    iclass.setServiceOrderSnapshot(ORDER_CODE, { iclassId: 'i1', iclassCodigo: ORDER_CODE, statusCode: '1', statusDescription: 'Aberta' });
    iclass.setCloseMode('unavailable');

    await expect(service.execute(makeTask(), 'closed', 'Ana')).resolves.toBeUndefined();
  });

  it('never throws — getServiceOrder failure is swallowed', async () => {
    const { iclass, service } = makeService();
    iclass.failureMode = 'unavailable';

    await expect(service.execute(makeTask(), 'closed', 'Ana')).resolves.toBeUndefined();
  });
});
