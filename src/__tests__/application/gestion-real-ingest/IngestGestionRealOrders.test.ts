import { IngestGestionRealOrders } from '@application/use-cases/IngestGestionRealOrders';
import { InMemoryGestionRealPort } from '@infrastructure/adapters/in-memory/InMemoryGestionRealPort';
import { InMemoryGrLinkResolver } from '@infrastructure/adapters/in-memory/InMemoryGrLinkResolver';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryGestionRealIngestConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryGestionRealIngestConfigRepository';
import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { InMemoryProjectRepository } from '@infrastructure/adapters/in-memory/InMemoryProjectRepository';
import { GrServiceOrder } from '@domain/entities/gestionReal';

const DEFAULT_STAGE_ID = '10000000-0000-4000-a000-000000000001';

function order(overrides: Partial<GrServiceOrder> & Pick<GrServiceOrder, 'grOrdenId'>): GrServiceOrder {
  return {
    grOrdenId: overrides.grOrdenId,
    tipo: overrides.tipo ?? 'CI',
    estado: overrides.estado ?? 'PEND',
    cliente: overrides.cliente ?? 'gr-cli-1',
    contrato: overrides.contrato ?? 'gr-con-1',
    domicilio:
      overrides.domicilio !== undefined
        ? overrides.domicilio
        : { direccion: 'Calle Falsa 123', localidad: 'Springfield', provincia: 'BA' },
    fechaCreacion: overrides.fechaCreacion ?? '01-05-2026 10:00:00',
    raw: overrides.raw ?? {},
  };
}

interface Harness {
  gr: InMemoryGestionRealPort;
  resolver: InMemoryGrLinkResolver;
  scheduling: InMemorySchedulingRepository;
  config: InMemoryGestionRealIngestConfigRepository;
  state: InMemorySyncStateRepository;
  projects: InMemoryProjectRepository;
  useCase: IngestGestionRealOrders;
}

async function makeHarness(): Promise<Harness> {
  const gr = new InMemoryGestionRealPort();
  const resolver = new InMemoryGrLinkResolver();
  const scheduling = new InMemorySchedulingRepository();
  const config = new InMemoryGestionRealIngestConfigRepository();
  const state = new InMemorySyncStateRepository();
  const projects = new InMemoryProjectRepository();
  await config.update({
    enabled: true,
    fiberProjectId: 'p-fiber',
    wirelessProjectId: 'p-wifi',
  });
  const useCase = new IngestGestionRealOrders(gr, resolver, scheduling, config, state, projects, {
    defaultStageId: DEFAULT_STAGE_ID,
    now: () => new Date('2026-05-29T12:00:00Z'),
  });
  return { gr, resolver, scheduling, config, state, projects, useCase };
}

describe('IngestGestionRealOrders', () => {
  it('processes only tipo=="CI" orders (REQ-FILTER-1)', async () => {
    const h = await makeHarness();
    h.resolver.seedClient('gr-cli-1', { id: 'cust-1', name: 'Acme' });
    h.resolver.seedService('gr-con-1', { id: 'svc-1', plan: '300MB' });
    h.gr.serviceOrders = [
      order({ grOrdenId: '1', tipo: 'CI' }),
      order({ grOrdenId: '2', tipo: 'CO' }),
      order({ grOrdenId: '3', tipo: 'BA' }),
    ];

    const result = await h.useCase.execute();

    expect(result.created).toBe(1);
    expect(await h.scheduling.findTaskByGrOrdenId('1')).not.toBeNull();
    expect(await h.scheduling.findTaskByGrOrdenId('2')).toBeNull();
    expect(await h.scheduling.findTaskByGrOrdenId('3')).toBeNull();
  });

  it('creates a fiber task targeting fiberProjectId (REQ-CREATE-1)', async () => {
    const h = await makeHarness();
    h.resolver.seedClient('gr-cli-1', { id: 'cust-1', name: 'Acme' });
    h.resolver.seedService('gr-con-1', { id: 'svc-1', plan: '300MB' });
    h.gr.serviceOrders = [order({ grOrdenId: '551' })];

    const result = await h.useCase.execute();

    expect(result.created).toBe(1);
    const task = await h.scheduling.findTaskByGrOrdenId('551');
    expect(task).not.toBeNull();
    expect(task!.customerId).toBe('cust-1');
    expect(task!.serviceId).toBe('svc-1');
    expect(task!.projectId).toBe('p-fiber');
    expect(task!.grOrdenId).toBe('551');
    expect(task!.address).toBe('Calle Falsa 123');
    expect(task!.title).toContain('Acme');
    expect(task!.title).not.toContain('REVISAR');
  });

  it('creates a wireless task targeting wirelessProjectId (REQ-CREATE-2)', async () => {
    const h = await makeHarness();
    h.resolver.seedClient('gr-cli-1', { id: 'cust-1', name: 'Bob' });
    h.resolver.seedService('gr-con-1', { id: 'svc-1', plan: '50/25MB' });
    h.gr.serviceOrders = [order({ grOrdenId: '600' })];

    const result = await h.useCase.execute();

    expect(result.created).toBe(1);
    const task = await h.scheduling.findTaskByGrOrdenId('600');
    expect(task!.projectId).toBe('p-wifi');
  });

  it('creates an unclassified needs-review task with no project (REQ-CREATE-3)', async () => {
    const h = await makeHarness();
    h.resolver.seedClient('gr-cli-1', { id: 'cust-1', name: 'Carol' });
    h.resolver.seedService('gr-con-1', { id: 'svc-1', plan: 'FIBRA SIN NUMERO' });
    h.gr.serviceOrders = [order({ grOrdenId: '700' })];

    const result = await h.useCase.execute();

    expect(result.unclassified).toBe(1);
    expect(result.created).toBe(0);
    const task = await h.scheduling.findTaskByGrOrdenId('700');
    expect(task).not.toBeNull();
    expect(task!.projectId).toBeNull();
    expect(task!.title.startsWith('[REVISAR - Logística] Instalación')).toBe(true);
    expect(task!.description).toContain('asignar tecnología');
    // appears in needs-review list
    const needsReview = await h.scheduling.listNeedsReview();
    expect(needsReview.some(t => t.grOrdenId === '700')).toBe(true);
  });

  it('skips an order whose client is not mirrored, batch continues (REQ-FK-2)', async () => {
    const h = await makeHarness();
    // order 1: client missing; order 2: fully resolvable
    h.resolver.seedClient('gr-cli-2', { id: 'cust-2', name: 'Dave' });
    h.resolver.seedService('gr-con-2', { id: 'svc-2', plan: '300MB' });
    h.gr.serviceOrders = [
      order({ grOrdenId: '10', cliente: 'gr-cli-MISSING', contrato: 'gr-con-2' }),
      order({ grOrdenId: '11', cliente: 'gr-cli-2', contrato: 'gr-con-2' }),
    ];

    const result = await h.useCase.execute();

    expect(result.skippedUnmirrored).toBe(1);
    expect(result.created).toBe(1);
    expect(await h.scheduling.findTaskByGrOrdenId('10')).toBeNull();
    expect(await h.scheduling.findTaskByGrOrdenId('11')).not.toBeNull();
  });

  it('skips an order whose service is not mirrored (REQ-FK-2)', async () => {
    const h = await makeHarness();
    h.resolver.seedClient('gr-cli-1', { id: 'cust-1', name: 'Eve' });
    // no service seeded for gr-con-1
    h.gr.serviceOrders = [order({ grOrdenId: '20' })];

    const result = await h.useCase.execute();

    expect(result.skippedUnmirrored).toBe(1);
    expect(result.created).toBe(0);
    expect(await h.scheduling.findTaskByGrOrdenId('20')).toBeNull();
  });

  it('is idempotent: re-running over the same order creates no duplicate (REQ-IDEMP-1)', async () => {
    const h = await makeHarness();
    h.resolver.seedClient('gr-cli-1', { id: 'cust-1', name: 'Frank' });
    h.resolver.seedService('gr-con-1', { id: 'svc-1', plan: '300MB' });
    h.gr.serviceOrders = [order({ grOrdenId: '900' })];

    const first = await h.useCase.execute();
    expect(first.created).toBe(1);

    const second = await h.useCase.execute();
    expect(second.created).toBe(0);
    expect(second.skippedDuplicate).toBe(1);

    // only one task exists with that grOrdenId
    const all = await h.scheduling.listTasks();
    expect(all.filter(t => t.grOrdenId === '900')).toHaveLength(1);
  });

  it('is a no-op returning zero counts when config is disabled (REQ-SCHED-2)', async () => {
    const h = await makeHarness();
    await h.config.update({ enabled: false });
    h.resolver.seedClient('gr-cli-1', { id: 'cust-1', name: 'Grace' });
    h.resolver.seedService('gr-con-1', { id: 'svc-1', plan: '300MB' });
    h.gr.serviceOrders = [order({ grOrdenId: '1000' })];

    const result = await h.useCase.execute();

    expect(result).toEqual({
      created: 0,
      skippedDuplicate: 0,
      skippedUnmirrored: 0,
      unclassified: 0,
    });
    expect(h.gr.serviceOrderCalls).toHaveLength(0);
    expect(await h.scheduling.findTaskByGrOrdenId('1000')).toBeNull();
  });

  it('persists run status + counts to SyncState under entity "gr-ingest"', async () => {
    const h = await makeHarness();
    h.resolver.seedClient('gr-cli-1', { id: 'cust-1', name: 'Heidi' });
    h.resolver.seedService('gr-con-1', { id: 'svc-1', plan: '300MB' });
    h.gr.serviceOrders = [order({ grOrdenId: '1100' })];

    await h.useCase.execute();

    const saved = await h.state.get('gr-ingest');
    expect(saved).not.toBeNull();
    expect(saved!.lastRunAt).toEqual(new Date('2026-05-29T12:00:00Z'));
    expect(saved!.itemsSynced).toBe(1);
    const counts = JSON.parse(saved!.lastResult ?? '{}');
    expect(counts).toMatchObject({
      created: 1,
      skippedDuplicate: 0,
      skippedUnmirrored: 0,
      unclassified: 0,
    });
  });

  it('queries GR with estado PEND, fecha_tipo c and a window derived from windowMonths', async () => {
    const h = await makeHarness();
    await h.config.update({ windowMonths: 6 });
    h.gr.serviceOrders = [];

    await h.useCase.execute();

    expect(h.gr.serviceOrderCalls).toHaveLength(1);
    const call = h.gr.serviceOrderCalls[0];
    expect(call.estado).toBe('PEND');
    expect(call.fechaTipo).toBe('c');
    // window: now=2026-05-29, 6 months back → 29-11-2025 .. 29-05-2026
    expect(call.fechaHasta).toBe('29-05-2026');
    expect(call.fechaDesde).toBe('29-11-2025');
  });
});
