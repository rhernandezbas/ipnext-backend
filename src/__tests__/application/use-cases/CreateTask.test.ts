import { CreateTask } from '../../../application/use-cases/CreateTask';
import { InMemorySchedulingRepository } from '../../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { ReferenceNotFoundError } from '../../../domain/errors/scheduling';
import { EntityLookup } from '../../../domain/ports/EntityLookup';
import { ProjectKindLookup } from '../../../domain/ports/ProjectKindLookup';

const DEFAULT_STAGE_ID = '10000000-0000-4000-a000-000000000001';
const DEFAULT_CUSTOMER_ID  = 'customer-default-0000-000000000001';
const DEFAULT_CONTRACT_ID  = 'contract-default-00000-000000000001';

// Simple in-memory lookup that can be pre-populated with known IDs
class StubLookup implements EntityLookup, ProjectKindLookup {
  private ids: Set<string>;
  constructor(...ids: string[]) { this.ids = new Set(ids); }
  async findById(id: string) { return this.ids.has(id) ? { id, isNetworkProject: false } : null; }
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
    // REQ-REQUIRED-1: customerId and contractId are required on create
    customerId: DEFAULT_CUSTOMER_ID,
    contractId: DEFAULT_CONTRACT_ID,
    partnerId: null,
    reporterId: null,
    assigneeId: null,
    watcherIds: [],
    travelTimeTo: null,
    travelTimeFrom: null,
    // network-node-task (#29) — kind discriminator
    kind: 'customer' as const,
    networkSiteId: null,
  };
}

function makeUseCase(overrides?: {
  customerLookup?: EntityLookup;
  contractLookup?: EntityLookup;
  partnerLookup?: EntityLookup;
  projectLookup?: ProjectKindLookup;
  adminLookup?: EntityLookup;
}) {
  const repo = new InMemorySchedulingRepository();
  const emptyLookup = new StubLookup();
  // Default lookups recognise the default IDs used in makeBase()
  const defaultCustomerLookup  = new StubLookup(DEFAULT_CUSTOMER_ID);
  const defaultContractLookup  = new StubLookup(DEFAULT_CONTRACT_ID);
  return {
    uc: new CreateTask(
      repo,
      overrides?.customerLookup  ?? defaultCustomerLookup,
      overrides?.contractLookup  ?? defaultContractLookup,
      overrides?.partnerLookup  ?? emptyLookup,
      overrides?.adminLookup    ?? emptyLookup,
      overrides?.projectLookup  ?? emptyLookup,
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

  it('throws ReferenceNotFoundError(contract) when contractId is not found', async () => {
    const { uc } = makeUseCase({ contractLookup: new StubLookup() });
    await expect(uc.execute({ ...makeBase(), contractId: 'ghost' }))
      .rejects.toMatchObject({ kind: 'contract', id: 'ghost' });
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
      uc.execute({ ...makeBase(), customerId: 'c-ghost', contractId: 's-ghost' })
    ).rejects.toMatchObject({ kind: 'customer' });
  });

  it('REQ-FK-ORDER-1: service check comes before partner', async () => {
    const { uc } = makeUseCase({ customerLookup: new StubLookup('cust-1') });
    await expect(
      uc.execute({ ...makeBase(), customerId: 'cust-1', contractId: 's-ghost', partnerId: 'p-ghost' })
    ).rejects.toMatchObject({ kind: 'contract' });
  });

  it('REQ-FK-ORDER-1: partner check comes before reporter', async () => {
    const { uc } = makeUseCase({
      customerLookup: new StubLookup('cust-1'),
      contractLookup: new StubLookup('svc-1'),
    });
    await expect(
      uc.execute({ ...makeBase(), customerId: 'cust-1', contractId: 'svc-1', partnerId: 'p-ghost', reporterId: 'r-ghost' })
    ).rejects.toMatchObject({ kind: 'partner' });
  });

  it('REQ-FK-ORDER-1: reporter check comes before assignee', async () => {
    const { uc } = makeUseCase({
      customerLookup: new StubLookup('cust-1'),
      contractLookup: new StubLookup('svc-1'),
      partnerLookup: new StubLookup('part-1'),
      adminLookup: new StubLookup(), // empty — both reporter and assignee are missing
    });
    await expect(
      uc.execute({ ...makeBase(), customerId: 'cust-1', contractId: 'svc-1', partnerId: 'part-1', reporterId: 'r-ghost', assigneeId: 'a-ghost' })
    ).rejects.toMatchObject({ kind: 'reporter' });
  });

  it('REQ-FK-ORDER-1: assignee check comes before watchers', async () => {
    const { uc } = makeUseCase({
      customerLookup: new StubLookup('cust-1'),
      contractLookup: new StubLookup('svc-1'),
      partnerLookup: new StubLookup('part-1'),
      adminLookup: new StubLookup(), // empty — assignee and watcher missing
    });
    await expect(
      uc.execute({ ...makeBase(), customerId: 'cust-1', contractId: 'svc-1', partnerId: 'part-1', assigneeId: 'a-ghost', watcherIds: ['w-ghost'] })
    ).rejects.toMatchObject({ kind: 'assignee' });
  });

  it('REQ-CREATE-12: throws ReferenceNotFoundError(project) when projectId is not found', async () => {
    const { uc } = makeUseCase({ projectLookup: new StubLookup() }); // empty — project unknown
    await expect(uc.execute({ ...makeBase(), projectId: 'ghost-project' }))
      .rejects.toMatchObject({ kind: 'project', id: 'ghost-project' });
    await expect(uc.execute({ ...makeBase(), projectId: 'ghost-project' }))
      .rejects.toBeInstanceOf(ReferenceNotFoundError);
  });

  it('REQ-CREATE-13a: null projectId skips project lookup', async () => {
    const { uc } = makeUseCase({ projectLookup: new StubLookup() }); // would reject any id
    const result = await uc.execute({ ...makeBase(), projectId: null });
    expect(result.id).toBeTruthy();
    expect(result.projectId).toBeNull();
  });

  it('REQ-CREATE-13b: absent projectId skips project lookup', async () => {
    const { uc } = makeUseCase({ projectLookup: new StubLookup() });
    const base = makeBase();
    // omit projectId entirely — not in the payload
    const { projectId: _omitted, ...withoutProject } = base;
    const result = await uc.execute({ ...withoutProject } as typeof base);
    expect(result.id).toBeTruthy();
  });

  it('REQ-FK-ORDER: project check comes after partner and before reporter', async () => {
    const { uc } = makeUseCase({
      customerLookup: new StubLookup('cust-1'),
      contractLookup: new StubLookup('svc-1'),
      partnerLookup: new StubLookup('part-1'),
      projectLookup: new StubLookup(), // empty — ghost project
    });
    await expect(
      uc.execute({ ...makeBase(), customerId: 'cust-1', contractId: 'svc-1', partnerId: 'part-1', projectId: 'proj-ghost', reporterId: 'r-ghost' })
    ).rejects.toMatchObject({ kind: 'project' }); // project fails before reporter
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

  it('happy path: customerId + serviceId both valid → creates task', async () => {
    const { uc } = makeUseCase();
    const result = await uc.execute(makeBase());
    expect(result.id).toBeTruthy();
  });

  it('REQ-REQUIRED-1: null customerId throws ReferenceNotFoundError (no longer bypassed)', async () => {
    // customerId is required — the use case must NOT skip validation for null
    const { uc } = makeUseCase({ customerLookup: new StubLookup(DEFAULT_CONTRACT_ID) }); // customer empty
    await expect(uc.execute({ ...makeBase(), customerId: null as unknown as string }))
      .rejects.toBeInstanceOf(ReferenceNotFoundError);
  });

  it('REQ-REQUIRED-2: null contractId throws ReferenceNotFoundError (no longer bypassed)', async () => {
    // contractId is required — the use case must NOT skip validation for null
    const { uc } = makeUseCase({ contractLookup: new StubLookup(DEFAULT_CUSTOMER_ID) }); // contract empty
    await expect(uc.execute({ ...makeBase(), contractId: null as unknown as string }))
      .rejects.toBeInstanceOf(ReferenceNotFoundError);
  });
});
