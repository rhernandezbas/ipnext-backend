import { IngestGestionRealOrders } from '@application/use-cases/IngestGestionRealOrders';
import { InMemoryGestionRealPort } from '@infrastructure/adapters/in-memory/InMemoryGestionRealPort';
import { InMemoryGrLinkResolver } from '@infrastructure/adapters/in-memory/InMemoryGrLinkResolver';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryGestionRealIngestConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryGestionRealIngestConfigRepository';
import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { InMemoryProjectRepository } from '@infrastructure/adapters/in-memory/InMemoryProjectRepository';
import { InMemoryFeatureFlagRepository } from '@infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { InMemoryStageRepository } from '@infrastructure/adapters/in-memory/InMemoryStageRepository';
import { InMemoryTaskPriorityRepository } from '@infrastructure/adapters/in-memory/InMemoryTaskPriorityRepository';
import { InMemoryTaskCategoryRepository } from '@infrastructure/adapters/in-memory/InMemoryTaskCategoryRepository';
import { GrServiceOrder } from '@domain/entities/gestionReal';
import { IngestCatalogEntryMissingError } from '@domain/errors/scheduling';

const DEFAULT_STAGE_ID = '10000000-0000-4000-a000-000000000001';
const INGEST_FLAG_KEY = 'gestion-real-ingest';

// The catalog NAMES the ingest must resolve. These MUST exist as rows in the
// TaskPriority / TaskCategory catalogs (see prod catalog: "Normal", "Instalación").
const INGEST_PRIORITY_NAME = 'Normal';
const INGEST_CATEGORY_NAME = 'Instalación';

/** Seed the two catalogs with the canonical entries the ingest depends on. */
async function seedCatalogs(
  priorities: InMemoryTaskPriorityRepository,
  categories: InMemoryTaskCategoryRepository,
): Promise<void> {
  await priorities.create({ name: INGEST_PRIORITY_NAME, color: '#888', weight: 2 });
  await categories.create({ name: INGEST_CATEGORY_NAME, description: null });
}

function order(overrides: Partial<GrServiceOrder> & Pick<GrServiceOrder, 'grOrdenId'>): GrServiceOrder {
  return {
    grOrdenId: overrides.grOrdenId,
    tipo: overrides.tipo ?? 'CI',
    estado: overrides.estado ?? 'CONF',
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
  featureFlags: InMemoryFeatureFlagRepository;
  priorities: InMemoryTaskPriorityRepository;
  categories: InMemoryTaskCategoryRepository;
  useCase: IngestGestionRealOrders;
}

async function makeHarness(): Promise<Harness> {
  const gr = new InMemoryGestionRealPort();
  const resolver = new InMemoryGrLinkResolver();
  const scheduling = new InMemorySchedulingRepository();
  const config = new InMemoryGestionRealIngestConfigRepository();
  const state = new InMemorySyncStateRepository();
  const projects = new InMemoryProjectRepository();
  const featureFlags = new InMemoryFeatureFlagRepository();
  const priorities = new InMemoryTaskPriorityRepository();
  const categories = new InMemoryTaskCategoryRepository();
  // Master switch ON by default; per-test we flip it to assert gating.
  featureFlags.seed(INGEST_FLAG_KEY, true);
  await seedCatalogs(priorities, categories);
  await config.update({
    fiberProjectId: 'p-fiber',
    wirelessProjectId: 'p-wifi',
  });
  const useCase = new IngestGestionRealOrders(gr, resolver, scheduling, config, state, projects, featureFlags, priorities, categories, {
    defaultStageId: DEFAULT_STAGE_ID,
    now: () => new Date('2026-05-29T12:00:00Z'),
  });
  return { gr, resolver, scheduling, config, state, projects, featureFlags, priorities, categories, useCase };
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
    // Priority/category MUST be the catalog NAMES, never the phantom 'normal'/'installation'.
    expect(task!.priority).toBe(INGEST_PRIORITY_NAME);
    expect(task!.category).toBe(INGEST_CATEGORY_NAME);
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

  // ── Feature flag master switch: gestion-real-ingest (single on/off gate) ──

  it('is a no-op (no GR call, zero counts) when the master flag is OFF (REQ-FLAG-1)', async () => {
    const h = await makeHarness();
    h.featureFlags.seed(INGEST_FLAG_KEY, false); // master switch OFF
    h.resolver.seedClient('gr-cli-1', { id: 'cust-1', name: 'Ivan' });
    h.resolver.seedService('gr-con-1', { id: 'svc-1', plan: '300MB' });
    h.gr.serviceOrders = [order({ grOrdenId: '2000' })];

    const result = await h.useCase.execute();

    expect(result).toEqual({
      created: 0,
      skippedDuplicate: 0,
      skippedUnmirrored: 0,
      unclassified: 0,
    });
    expect(h.gr.serviceOrderCalls).toHaveLength(0);
    expect(await h.scheduling.findTaskByGrOrdenId('2000')).toBeNull();
  });

  it('is a no-op when the master flag row is absent entirely (default OFF) (REQ-FLAG-1)', async () => {
    const h = await makeHarness();
    await h.featureFlags.setEnabled(INGEST_FLAG_KEY, false); // ensure present...
    // ...then simulate a never-seeded flag by using a fresh repo on a new use case.
    const featureFlags = new InMemoryFeatureFlagRepository(); // no seed → get() returns null
    const useCase = new IngestGestionRealOrders(
      h.gr,
      h.resolver,
      h.scheduling,
      h.config,
      h.state,
      h.projects,
      featureFlags,
      h.priorities,
      h.categories,
      { defaultStageId: DEFAULT_STAGE_ID, now: () => new Date('2026-05-29T12:00:00Z') },
    );
    h.resolver.seedClient('gr-cli-1', { id: 'cust-1', name: 'Judy' });
    h.resolver.seedService('gr-con-1', { id: 'svc-1', plan: '300MB' });
    h.gr.serviceOrders = [order({ grOrdenId: '2100' })];

    const result = await useCase.execute();

    expect(result.created).toBe(0);
    expect(h.gr.serviceOrderCalls).toHaveLength(0);
    expect(await h.scheduling.findTaskByGrOrdenId('2100')).toBeNull();
  });

  it('runs the ingest when the master flag is ON (REQ-FLAG-2)', async () => {
    const h = await makeHarness(); // flag seeded ON
    h.resolver.seedClient('gr-cli-1', { id: 'cust-1', name: 'Karl' });
    h.resolver.seedService('gr-con-1', { id: 'svc-1', plan: '300MB' });
    h.gr.serviceOrders = [order({ grOrdenId: '2200' })];

    const result = await h.useCase.execute();

    expect(result.created).toBe(1);
    expect(h.gr.serviceOrderCalls).toHaveLength(1);
    expect(await h.scheduling.findTaskByGrOrdenId('2200')).not.toBeNull();
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

  it('queries GR with the configured source estado (default CONF), fecha_tipo c and a window derived from windowMonths', async () => {
    const h = await makeHarness();
    await h.config.update({ windowMonths: 6 });
    h.gr.serviceOrders = [];

    await h.useCase.execute();

    expect(h.gr.serviceOrderCalls).toHaveLength(1);
    const call = h.gr.serviceOrderCalls[0];
    expect(call.estado).toBe('CONF');
    expect(call.fechaTipo).toBe('c');
    // window: now=2026-05-29, 6 months back → 29-11-2025 .. 29-05-2026
    expect(call.fechaHasta).toBe('29-05-2026');
    expect(call.fechaDesde).toBe('29-11-2025');
  });

  // ── FIX 1 (C1): classified but target project not configured → needs-review ──

  it('FIBER order with no fiberProjectId becomes a needs-review task (C1)', async () => {
    const gr = new InMemoryGestionRealPort();
    const resolver = new InMemoryGrLinkResolver();
    const scheduling = new InMemorySchedulingRepository();
    const config = new InMemoryGestionRealIngestConfigRepository();
    const state = new InMemorySyncStateRepository();
    const projects = new InMemoryProjectRepository();
    const featureFlags = new InMemoryFeatureFlagRepository();
    featureFlags.seed(INGEST_FLAG_KEY, true);
    const priorities = new InMemoryTaskPriorityRepository();
    const categories = new InMemoryTaskCategoryRepository();
    await seedCatalogs(priorities, categories);
    await config.update({ fiberProjectId: null, wirelessProjectId: 'p-wifi' });
    const useCase = new IngestGestionRealOrders(gr, resolver, scheduling, config, state, projects, featureFlags, priorities, categories, {
      defaultStageId: DEFAULT_STAGE_ID,
      now: () => new Date('2026-05-29T12:00:00Z'),
    });
    resolver.seedClient('gr-cli-1', { id: 'cust-1', name: 'Acme' });
    resolver.seedService('gr-con-1', { id: 'svc-1', plan: '300MB' });
    gr.serviceOrders = [order({ grOrdenId: 'f1' })];

    const result = await useCase.execute();

    expect(result.unclassified).toBe(1);
    expect(result.created).toBe(0);
    const task = await scheduling.findTaskByGrOrdenId('f1');
    expect(task).not.toBeNull();
    expect(task!.projectId).toBeNull();
    expect(task!.title.startsWith('[REVISAR - Logística] Instalación')).toBe(true);
    expect(task!.description).toContain('FIBRA');
    expect(task!.description).toContain('no configurado');
    // distinct from the unparseable-plan reason
    expect(task!.description).not.toContain('Plan no reconocido');
    const needsReview = await scheduling.listNeedsReview();
    expect(needsReview.some(t => t.grOrdenId === 'f1')).toBe(true);
  });

  it('WIRELESS order with no wirelessProjectId becomes a needs-review task (C1)', async () => {
    const gr = new InMemoryGestionRealPort();
    const resolver = new InMemoryGrLinkResolver();
    const scheduling = new InMemorySchedulingRepository();
    const config = new InMemoryGestionRealIngestConfigRepository();
    const state = new InMemorySyncStateRepository();
    const projects = new InMemoryProjectRepository();
    const featureFlags = new InMemoryFeatureFlagRepository();
    featureFlags.seed(INGEST_FLAG_KEY, true);
    const priorities = new InMemoryTaskPriorityRepository();
    const categories = new InMemoryTaskCategoryRepository();
    await seedCatalogs(priorities, categories);
    await config.update({ fiberProjectId: 'p-fiber', wirelessProjectId: null });
    const useCase = new IngestGestionRealOrders(gr, resolver, scheduling, config, state, projects, featureFlags, priorities, categories, {
      defaultStageId: DEFAULT_STAGE_ID,
      now: () => new Date('2026-05-29T12:00:00Z'),
    });
    resolver.seedClient('gr-cli-1', { id: 'cust-1', name: 'Bob' });
    resolver.seedService('gr-con-1', { id: 'svc-1', plan: '30/10 MB' });
    gr.serviceOrders = [order({ grOrdenId: 'w1' })];

    const result = await useCase.execute();

    expect(result.unclassified).toBe(1);
    expect(result.created).toBe(0);
    const task = await scheduling.findTaskByGrOrdenId('w1');
    expect(task!.projectId).toBeNull();
    expect(task!.title.startsWith('[REVISAR - Logística] Instalación')).toBe(true);
    expect(task!.description).toContain('WIRELESS');
    expect(task!.description).toContain('no configurado');
    expect(task!.description).not.toContain('Plan no reconocido');
  });

  // ── FIX 2: unique-violation on createTask must not abort the batch ──

  it('unique-violation on createTask counts as skippedDuplicate, batch continues (FIX2)', async () => {
    const h = await makeHarness();
    h.resolver.seedClient('gr-cli-1', { id: 'cust-1', name: 'Acme' });
    h.resolver.seedService('gr-con-1', { id: 'svc-1', plan: '300MB' });
    h.gr.serviceOrders = [
      order({ grOrdenId: 'dup-1' }),
      order({ grOrdenId: 'ok-2' }),
    ];

    // Make createTask throw a unique-violation-shaped error for the first order only.
    const realCreate = h.scheduling.createTask.bind(h.scheduling);
    h.scheduling.createTask = async (data: Parameters<typeof realCreate>[0]) => {
      if (data.grOrdenId === 'dup-1') {
        const err: Error & { code?: string } = new Error(
          'Unique constraint failed on the fields: (`grOrdenId`)',
        );
        err.code = 'P2002';
        throw err;
      }
      return realCreate(data);
    };

    const result = await h.useCase.execute();

    expect(result.skippedDuplicate).toBe(1);
    expect(result.created).toBe(1);
    // the non-conflicting order still got created
    expect(await h.scheduling.findTaskByGrOrdenId('ok-2')).not.toBeNull();
    // run still persisted status (batch did not abort)
    const saved = await h.state.get('gr-ingest');
    expect(saved).not.toBeNull();
  });

  // ── FIX 3: re-filter estado app-side against the configured source estado ──

  it('skips a CI order whose estado != config.sourceEstado (default CONF) (FIX3)', async () => {
    const h = await makeHarness();
    h.resolver.seedClient('gr-cli-1', { id: 'cust-1', name: 'Acme' });
    h.resolver.seedService('gr-con-1', { id: 'svc-1', plan: '300MB' });
    h.gr.serviceOrders = [
      // CI but estado != CONF → must be skipped even though it's an installation.
      order({ grOrdenId: 'pend', estado: 'PEND' }),
      order({ grOrdenId: 'conf', estado: 'CONF' }),
    ];

    const result = await h.useCase.execute();

    expect(result.created).toBe(1);
    expect(await h.scheduling.findTaskByGrOrdenId('pend')).toBeNull();
    expect(await h.scheduling.findTaskByGrOrdenId('conf')).not.toBeNull();
  });

  it('honors a non-default config.sourceEstado (PEND): queries GR with PEND and ingests only PEND CI orders', async () => {
    const h = await makeHarness();
    await h.config.update({ sourceEstado: 'PEND' });
    h.resolver.seedClient('gr-cli-1', { id: 'cust-1', name: 'Acme' });
    h.resolver.seedService('gr-con-1', { id: 'svc-1', plan: '300MB' });
    h.gr.serviceOrders = [
      order({ grOrdenId: 'pend', estado: 'PEND' }),
      order({ grOrdenId: 'conf', estado: 'CONF' }),
    ];

    const result = await h.useCase.execute();

    expect(h.gr.serviceOrderCalls[0].estado).toBe('PEND');
    expect(result.created).toBe(1);
    expect(await h.scheduling.findTaskByGrOrdenId('pend')).not.toBeNull();
    expect(await h.scheduling.findTaskByGrOrdenId('conf')).toBeNull();
  });

  // ── PROD FIX: resolve the workflow's INITIAL stage, not a magic "Pendiente" ──

  it('classified order lands in the target workflow\'s initial stage (lowest order), not the blank default', async () => {
    // The real installation workflow has NO "Pendiente" stage — its entry stage
    // is "Nuevo" (order 0). The task must land there, NOT in the empty default.
    const gr = new InMemoryGestionRealPort();
    const resolver = new InMemoryGrLinkResolver();
    const stageRepo = new InMemoryStageRepository();
    const scheduling = new InMemorySchedulingRepository(stageRepo);
    const config = new InMemoryGestionRealIngestConfigRepository();
    const state = new InMemorySyncStateRepository();
    const projects = new InMemoryProjectRepository();
    const featureFlags = new InMemoryFeatureFlagRepository();
    featureFlags.seed(INGEST_FLAG_KEY, true);

    // Build the fiber project with an installation workflow whose stages mirror prod.
    const wfId = 'wf-fiber-install';
    const nuevo = await stageRepo.add(wfId, { name: 'Nuevo', category: 'nuevo', order: 0 });
    await stageRepo.add(wfId, { name: 'Confirmado', category: 'enProgreso', order: 1 });
    await stageRepo.add(wfId, { name: 'Enviar a IClass', category: 'enProgreso', order: 5 });
    const fiberProject = await projects.create({ title: 'INSTALACION FIBRA', workflowId: wfId });

    const priorities = new InMemoryTaskPriorityRepository();
    const categories = new InMemoryTaskCategoryRepository();
    await seedCatalogs(priorities, categories);
    await config.update({ fiberProjectId: fiberProject.id, wirelessProjectId: null });
    const useCase = new IngestGestionRealOrders(gr, resolver, scheduling, config, state, projects, featureFlags, priorities, categories, {
      // Intentionally BLANK default — the workflow's initial stage must be used.
      defaultStageId: '',
      now: () => new Date('2026-05-29T12:00:00Z'),
    });
    resolver.seedClient('gr-cli-1', { id: 'cust-1', name: 'Acme' });
    resolver.seedService('gr-con-1', { id: 'svc-1', plan: '300MB' });
    gr.serviceOrders = [order({ grOrdenId: 'ws-1' })];

    const result = await useCase.execute();

    expect(result.created).toBe(1);
    const task = await scheduling.findTaskByGrOrdenId('ws-1');
    expect(task).not.toBeNull();
    expect(task!.projectId).toBe(fiberProject.id);
    // The fix: stage resolved via getInitialStage → "Nuevo" (order 0), NOT blank.
    expect(task!.stageId).toBe(nuevo.id);
    expect(task!.stageId).not.toBe('');
  });

  // ── FIX 4: month-window overflow on long→short month transition ──

  it('window start does not overflow when run on the 31st (FIX4)', async () => {
    const gr = new InMemoryGestionRealPort();
    const resolver = new InMemoryGrLinkResolver();
    const scheduling = new InMemorySchedulingRepository();
    const config = new InMemoryGestionRealIngestConfigRepository();
    const state = new InMemorySyncStateRepository();
    const projects = new InMemoryProjectRepository();
    const featureFlags = new InMemoryFeatureFlagRepository();
    featureFlags.seed(INGEST_FLAG_KEY, true);
    const priorities = new InMemoryTaskPriorityRepository();
    const categories = new InMemoryTaskCategoryRepository();
    await seedCatalogs(priorities, categories);
    await config.update({ windowMonths: 1 });
    const useCase = new IngestGestionRealOrders(gr, resolver, scheduling, config, state, projects, featureFlags, priorities, categories, {
      defaultStageId: DEFAULT_STAGE_ID,
      // 2026-03-31 local time (avoid TZ rollover): construct via local Date.
      now: () => new Date(2026, 2, 31, 12, 0, 0),
    });
    gr.serviceOrders = [];

    await useCase.execute();

    const call = gr.serviceOrderCalls[0];
    expect(call.fechaHasta).toBe('31-03-2026');
    // 1 month back must land in February, not roll forward into March.
    expect(call.fechaDesde).toBe('28-02-2026');
  });

  // ── CATALOG FIX: priority/category must come from the real catalogs ──

  it('created task uses the catalog NAMES "Normal"/"Instalación", not phantom values', async () => {
    const h = await makeHarness();
    h.resolver.seedClient('gr-cli-1', { id: 'cust-1', name: 'Acme' });
    h.resolver.seedService('gr-con-1', { id: 'svc-1', plan: '300MB' });
    h.gr.serviceOrders = [order({ grOrdenId: 'cat-1' })];

    const result = await h.useCase.execute();

    expect(result.created).toBe(1);
    const task = await h.scheduling.findTaskByGrOrdenId('cat-1');
    expect(task!.priority).toBe('Normal');
    expect(task!.category).toBe('Instalación');
    // The old hardcoded phantom values must be gone.
    expect(task!.priority).not.toBe('normal');
    expect(task!.category).not.toBe('installation');
  });

  it('needs-review task ALSO uses the catalog NAMES (priority/category resolved)', async () => {
    const h = await makeHarness();
    h.resolver.seedClient('gr-cli-1', { id: 'cust-1', name: 'Carol' });
    h.resolver.seedService('gr-con-1', { id: 'svc-1', plan: 'FIBRA SIN NUMERO' });
    h.gr.serviceOrders = [order({ grOrdenId: 'cat-rev' })];

    await h.useCase.execute();

    const task = await h.scheduling.findTaskByGrOrdenId('cat-rev');
    expect(task!.priority).toBe('Normal');
    expect(task!.category).toBe('Instalación');
  });

  it('BLOCKS the run and creates ZERO tasks when the priority catalog lacks "Normal"', async () => {
    const h = await makeHarness();
    // Wipe the priority catalog so "Normal" cannot be resolved (only a foreign entry).
    const fresh = new InMemoryTaskPriorityRepository();
    await fresh.create({ name: 'Baja', color: '#aaa', weight: 1 });
    const useCase = new IngestGestionRealOrders(
      h.gr, h.resolver, h.scheduling, h.config, h.state, h.projects, h.featureFlags,
      fresh, h.categories,
      { defaultStageId: DEFAULT_STAGE_ID, now: () => new Date('2026-05-29T12:00:00Z') },
    );
    h.resolver.seedClient('gr-cli-1', { id: 'cust-1', name: 'Acme' });
    h.resolver.seedService('gr-con-1', { id: 'svc-1', plan: '300MB' });
    h.gr.serviceOrders = [order({ grOrdenId: 'blk-1' }), order({ grOrdenId: 'blk-2' })];

    await expect(useCase.execute()).rejects.toBeInstanceOf(IngestCatalogEntryMissingError);

    // ZERO ingested tasks created — blocking is absolute (pre-seeded demo tasks
    // have no grOrdenId, so filtering by grOrdenId isolates the ingest output).
    expect(await h.scheduling.findTaskByGrOrdenId('blk-1')).toBeNull();
    expect(await h.scheduling.findTaskByGrOrdenId('blk-2')).toBeNull();
    const all = await h.scheduling.listTasks();
    expect(all.filter(t => t.grOrdenId != null)).toHaveLength(0);
  });

  it('BLOCKS the run and creates ZERO tasks when the category catalog lacks "Instalación"', async () => {
    const h = await makeHarness();
    const fresh = new InMemoryTaskCategoryRepository();
    await fresh.create({ name: 'Otro', description: null });
    const useCase = new IngestGestionRealOrders(
      h.gr, h.resolver, h.scheduling, h.config, h.state, h.projects, h.featureFlags,
      h.priorities, fresh,
      { defaultStageId: DEFAULT_STAGE_ID, now: () => new Date('2026-05-29T12:00:00Z') },
    );
    h.resolver.seedClient('gr-cli-1', { id: 'cust-1', name: 'Acme' });
    h.resolver.seedService('gr-con-1', { id: 'svc-1', plan: '300MB' });
    h.gr.serviceOrders = [order({ grOrdenId: 'blk-3' })];

    await expect(useCase.execute()).rejects.toBeInstanceOf(IngestCatalogEntryMissingError);

    expect(await h.scheduling.findTaskByGrOrdenId('blk-3')).toBeNull();
    const all = await h.scheduling.listTasks();
    expect(all.filter(t => t.grOrdenId != null)).toHaveLength(0);
  });
});
