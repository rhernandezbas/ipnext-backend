/**
 * TDD — #41 generalStatus facade (mirror of scheduling.isClosed.test.ts).
 *
 * Covers:
 * 1. PrismaSchedulingRepository.toTask: derive-on-read with legacy-row fallback
 *    (no column → from isClosed), explicit generalStatus, dismissed → isClosed=false.
 * 2. InMemorySchedulingRepository: create defaults to 'open'; updateTask syncs
 *    generalStatus ↔ isClosed; isClosed → generalStatus; generalStatus precedence.
 */

import { toTask } from '../../infrastructure/adapters/prisma/PrismaSchedulingRepository';
import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';

const DEFAULT_STAGE_ID_PENDING = '10000000-0000-4000-a000-000000000001';

const BASE_ROW = {
  id: 'test-1',
  sequenceNumber: 1,
  title: 'Test task',
  description: null,
  priority: 'normal',
  estimatedHours: 1,
  address: null,
  lat: null,
  lng: null,
  category: 'other',
  projectId: null,
  project: null,
  completedAt: null,
  notes: null,
  stageId: 'stage-1',
  stage: { id: 'stage-1', name: 'Nuevo', category: 'nuevo' },
  startDate: null,
  endDate: null,
  customerId: null,
  customer: null,
  contractId: null,
  partnerId: null,
  reporterId: null,
  assigneeId: null,
  assignee: null,
  watchers: [],
  checklist: [],
  travelTimeTo: null,
  travelTimeFrom: null,
  isClosed: false,
  createdAt: new Date('2026-05-01T00:00:00Z'),
  updatedAt: new Date('2026-05-01T00:00:00Z'),
};

const CREATE_INPUT = {
  title: 'Tarea de prueba',
  description: null,
  stageId: DEFAULT_STAGE_ID_PENDING,
  priority: 'normal',
  estimatedHours: 1,
  address: null,
  coordinates: null,
  category: 'other',
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
};

// ── 1. Prisma toTask — derive-on-read ──────────────────────────────────────────

describe('toTask — generalStatus derive-on-read', () => {
  it('maps explicit generalStatus from the row', () => {
    const task = toTask({ ...BASE_ROW, generalStatus: 'closed', isClosed: true });
    expect(task.generalStatus).toBe('closed');
    expect(task.isClosed).toBe(true);
  });

  it('derives isClosed=false for a dismissed task (NOT closed)', () => {
    const task = toTask({ ...BASE_ROW, generalStatus: 'dismissed', isClosed: false });
    expect(task.generalStatus).toBe('dismissed');
    expect(task.isClosed).toBe(false);
  });

  it('falls back to legacy isClosed when generalStatus column is absent (closed)', () => {
    const legacy = { ...BASE_ROW, isClosed: true } as Record<string, unknown>;
    delete legacy['generalStatus'];
    const task = toTask(legacy);
    expect(task.generalStatus).toBe('closed');
    expect(task.isClosed).toBe(true);
  });

  it('falls back to open when generalStatus absent and isClosed=false (legacy open)', () => {
    const legacy = { ...BASE_ROW, isClosed: false } as Record<string, unknown>;
    delete legacy['generalStatus'];
    const task = toTask(legacy);
    expect(task.generalStatus).toBe('open');
    expect(task.isClosed).toBe(false);
  });
});

// ── 2. InMemory — create / update sync ─────────────────────────────────────────

describe('InMemorySchedulingRepository — generalStatus', () => {
  it('createTask defaults generalStatus to open and isClosed to false', async () => {
    const repo = new InMemorySchedulingRepository();
    const task = await repo.createTask(CREATE_INPUT);
    expect(task.generalStatus).toBe('open');
    expect(task.isClosed).toBe(false);
  });

  it('updateTask generalStatus=closed syncs isClosed to true', async () => {
    const repo = new InMemorySchedulingRepository();
    const created = await repo.createTask(CREATE_INPUT);
    const updated = await repo.updateTask(created.id, { generalStatus: 'closed' });
    expect(updated!.generalStatus).toBe('closed');
    expect(updated!.isClosed).toBe(true);
  });

  it('updateTask generalStatus=dismissed leaves isClosed false', async () => {
    const repo = new InMemorySchedulingRepository();
    const created = await repo.createTask(CREATE_INPUT);
    const updated = await repo.updateTask(created.id, { generalStatus: 'dismissed' });
    expect(updated!.generalStatus).toBe('dismissed');
    expect(updated!.isClosed).toBe(false);
  });

  it('updateTask isClosed=true derives generalStatus=closed (legacy path)', async () => {
    const repo = new InMemorySchedulingRepository();
    const created = await repo.createTask(CREATE_INPUT);
    const updated = await repo.updateTask(created.id, { isClosed: true });
    expect(updated!.generalStatus).toBe('closed');
    expect(updated!.isClosed).toBe(true);
  });

  it('updateTask isClosed=false derives generalStatus=open', async () => {
    const repo = new InMemorySchedulingRepository();
    const created = await repo.createTask(CREATE_INPUT);
    await repo.updateTask(created.id, { isClosed: true });
    const reopened = await repo.updateTask(created.id, { isClosed: false });
    expect(reopened!.generalStatus).toBe('open');
    expect(reopened!.isClosed).toBe(false);
  });

  it('generalStatus wins over isClosed when both present (precedence D4)', async () => {
    const repo = new InMemorySchedulingRepository();
    const created = await repo.createTask(CREATE_INPUT);
    const updated = await repo.updateTask(created.id, { isClosed: true, generalStatus: 'dismissed' });
    expect(updated!.generalStatus).toBe('dismissed');
    expect(updated!.isClosed).toBe(false);
  });

  it('seeded tasks default to generalStatus open', async () => {
    const repo = new InMemorySchedulingRepository();
    const tasks = await repo.listTasks();
    tasks.forEach(t => expect(t.generalStatus).toBe('open'));
  });
});

// ── 3. InMemory — listTasks ?status filter ─────────────────────────────────────

describe('InMemorySchedulingRepository — listTasks status filter', () => {
  async function seedThree(repo: InMemorySchedulingRepository) {
    const open = await repo.createTask({ ...CREATE_INPUT, title: 'open' });
    const closed = await repo.createTask({ ...CREATE_INPUT, title: 'closed' });
    await repo.updateTask(closed.id, { generalStatus: 'closed' });
    const dismissed = await repo.createTask({ ...CREATE_INPUT, title: 'dismissed' });
    await repo.updateTask(dismissed.id, { generalStatus: 'dismissed' });
    return { open, closed, dismissed };
  }

  it('status=closed returns only closed tasks', async () => {
    const repo = new InMemorySchedulingRepository();
    const { open, closed, dismissed } = await seedThree(repo);
    const ids = (await repo.listTasks({ status: 'closed' })).map(t => t.id);
    expect(ids).toContain(closed.id);
    expect(ids).not.toContain(open.id);
    expect(ids).not.toContain(dismissed.id);
  });

  it('status=dismissed returns only dismissed tasks', async () => {
    const repo = new InMemorySchedulingRepository();
    const { open, closed, dismissed } = await seedThree(repo);
    const ids = (await repo.listTasks({ status: 'dismissed' })).map(t => t.id);
    expect(ids).toContain(dismissed.id);
    expect(ids).not.toContain(open.id);
    expect(ids).not.toContain(closed.id);
  });

  it('status=all returns every status', async () => {
    const repo = new InMemorySchedulingRepository();
    const { open, closed, dismissed } = await seedThree(repo);
    const ids = (await repo.listTasks({ status: 'all' })).map(t => t.id);
    expect(ids).toEqual(expect.arrayContaining([open.id, closed.id, dismissed.id]));
  });
});
