import { CreateTask } from '../../../application/use-cases/CreateTask';
import { InMemorySchedulingRepository } from '../../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { ReferenceNotFoundError } from '../../../domain/errors/scheduling';
import { EntityLookup } from '../../../domain/ports/EntityLookup';

const DEFAULT_STAGE_ID = '10000000-0000-4000-a000-000000000001';

// Simple in-memory lookup that can be pre-populated with known IDs
class StubLookup implements EntityLookup {
  private ids: Set<string>;
  constructor(...ids: string[]) { this.ids = new Set(ids); }
  async findById(id: string) { return this.ids.has(id) ? { id } : null; }
}

function makeBase() {
  return {
    title: 'Test task',
    description: null,
    assignedTo: null,
    assignedToId: null,
    clientId: null,
    clientName: null,
    stageId: DEFAULT_STAGE_ID,
    priority: 'normal' as const,
    scheduledDate: null,
    scheduledTime: null,
    estimatedHours: 1,
    address: null,
    coordinates: null,
    category: 'installation' as const,
    projectId: null,
    projectName: null,
    completedAt: null,
    notes: null,
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
  };
}

function makeUseCase(overrides?: {
  customerLookup?: EntityLookup;
  serviceLookup?: EntityLookup;
  partnerLookup?: EntityLookup;
  adminLookup?: EntityLookup;
}) {
  const repo = new InMemorySchedulingRepository();
  const emptyLookup = new StubLookup();
  return {
    uc: new CreateTask(
      repo,
      overrides?.customerLookup ?? emptyLookup,
      overrides?.serviceLookup ?? emptyLookup,
      overrides?.partnerLookup ?? emptyLookup,
      overrides?.adminLookup ?? emptyLookup,
    ),
    repo,
  };
}

describe('CreateTask — FK validation', () => {
  it('throws ReferenceNotFoundError(customer) when customerId is not found', async () => {
    const { uc } = makeUseCase({ customerLookup: new StubLookup() });
    await expect(uc.execute({ ...makeBase(), customerId: 'ghost' }))
      .rejects.toMatchObject({ kind: 'customer', id: 'ghost' });
    await expect(uc.execute({ ...makeBase(), customerId: 'ghost' }))
      .rejects.toBeInstanceOf(ReferenceNotFoundError);
  });

  it('throws ReferenceNotFoundError(service) when serviceId is not found', async () => {
    const { uc } = makeUseCase({ serviceLookup: new StubLookup() });
    await expect(uc.execute({ ...makeBase(), serviceId: 'ghost' }))
      .rejects.toMatchObject({ kind: 'service', id: 'ghost' });
  });

  it('throws ReferenceNotFoundError(partner) when partnerId is not found', async () => {
    const { uc } = makeUseCase({ partnerLookup: new StubLookup() });
    await expect(uc.execute({ ...makeBase(), partnerId: 'ghost' }))
      .rejects.toMatchObject({ kind: 'partner', id: 'ghost' });
  });

  it('throws ReferenceNotFoundError(reporter) when reporterId is not found', async () => {
    const { uc } = makeUseCase({ adminLookup: new StubLookup() });
    await expect(uc.execute({ ...makeBase(), reporterId: 'ghost' }))
      .rejects.toMatchObject({ kind: 'reporter', id: 'ghost' });
  });

  it('throws ReferenceNotFoundError(assignee) when assigneeId is not found', async () => {
    const { uc } = makeUseCase({ adminLookup: new StubLookup() });
    await expect(uc.execute({ ...makeBase(), assigneeId: 'ghost' }))
      .rejects.toMatchObject({ kind: 'assignee', id: 'ghost' });
  });

  it('throws ReferenceNotFoundError(watcher) when a watcherId is not found', async () => {
    const { uc } = makeUseCase({ adminLookup: new StubLookup('valid-admin') });
    await expect(uc.execute({ ...makeBase(), watcherIds: ['valid-admin', 'ghost'] }))
      .rejects.toMatchObject({ kind: 'watcher', id: 'ghost' });
  });

  it('REQ-FK-ORDER-1: customer check comes before service when both are missing', async () => {
    const { uc } = makeUseCase();
    await expect(
      uc.execute({ ...makeBase(), customerId: 'c-ghost', serviceId: 's-ghost' })
    ).rejects.toMatchObject({ kind: 'customer' });
  });

  it('REQ-FK-ORDER-1: service check comes before partner', async () => {
    const { uc } = makeUseCase({ customerLookup: new StubLookup('cust-1') });
    await expect(
      uc.execute({ ...makeBase(), customerId: 'cust-1', serviceId: 's-ghost', partnerId: 'p-ghost' })
    ).rejects.toMatchObject({ kind: 'service' });
  });

  it('REQ-FK-ORDER-1: partner check comes before reporter', async () => {
    const { uc } = makeUseCase({
      customerLookup: new StubLookup('cust-1'),
      serviceLookup: new StubLookup('svc-1'),
    });
    await expect(
      uc.execute({ ...makeBase(), customerId: 'cust-1', serviceId: 'svc-1', partnerId: 'p-ghost', reporterId: 'r-ghost' })
    ).rejects.toMatchObject({ kind: 'partner' });
  });

  it('REQ-FK-ORDER-1: reporter check comes before assignee', async () => {
    const { uc } = makeUseCase({
      customerLookup: new StubLookup('cust-1'),
      serviceLookup: new StubLookup('svc-1'),
      partnerLookup: new StubLookup('part-1'),
      adminLookup: new StubLookup(), // empty — both reporter and assignee are missing
    });
    await expect(
      uc.execute({ ...makeBase(), customerId: 'cust-1', serviceId: 'svc-1', partnerId: 'part-1', reporterId: 'r-ghost', assigneeId: 'a-ghost' })
    ).rejects.toMatchObject({ kind: 'reporter' });
  });

  it('REQ-FK-ORDER-1: assignee check comes before watchers', async () => {
    const { uc } = makeUseCase({
      customerLookup: new StubLookup('cust-1'),
      serviceLookup: new StubLookup('svc-1'),
      partnerLookup: new StubLookup('part-1'),
      adminLookup: new StubLookup(), // empty — assignee and watcher missing
    });
    await expect(
      uc.execute({ ...makeBase(), customerId: 'cust-1', serviceId: 'svc-1', partnerId: 'part-1', assigneeId: 'a-ghost', watcherIds: ['w-ghost'] })
    ).rejects.toMatchObject({ kind: 'assignee' });
  });

  it('happy path: all FKs valid → creates task, preserves watcherIds', async () => {
    const { uc } = makeUseCase({
      customerLookup: new StubLookup('cust-1'),
      adminLookup: new StubLookup('admin-1', 'watcher-1', 'watcher-2'),
    });
    const result = await uc.execute({
      ...makeBase(),
      customerId: 'cust-1',
      assigneeId: 'admin-1',
      watcherIds: ['watcher-1', 'watcher-2'],
    });
    expect(result.id).toBeTruthy();
    expect(result.watcherIds).toEqual(['watcher-1', 'watcher-2']);
  });

  it('happy path: no FKs provided → creates task without lookup', async () => {
    const { uc } = makeUseCase();
    const result = await uc.execute(makeBase());
    expect(result.id).toBeTruthy();
  });

  it('null FKs skip validation', async () => {
    const { uc } = makeUseCase(); // empty lookups
    const result = await uc.execute({
      ...makeBase(),
      customerId: null,
      serviceId: null,
      assigneeId: null,
    });
    expect(result.id).toBeTruthy();
  });
});
