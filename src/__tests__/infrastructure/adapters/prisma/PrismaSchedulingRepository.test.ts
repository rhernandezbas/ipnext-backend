/**
 * Unit tests for PrismaSchedulingRepository.toTask — new enriched fields
 * Tests legacy-only row, FK-resolved row, and watchers population.
 */
import { toTask } from '../../../../infrastructure/adapters/prisma/PrismaSchedulingRepository';

function makeBaseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    sequenceNumber: 1,
    title: 'Test',
    description: null,
    assignedTo: null,
    assignedToId: null,
    clientId: null,
    clientName: null,
    status: 'pending',
    priority: 'normal',
    scheduledDate: null,
    scheduledTime: null,
    estimatedHours: 1,
    address: null,
    lat: null,
    lng: null,
    category: 'installation',
    projectId: null,
    project: null,
    stageId: 'stage-1',
    stage: { id: 'stage-1', name: 'Nuevo', category: 'nuevo' },
    completedAt: null,
    notes: null,
    // New FK fields (all null in legacy row)
    startDate: null,
    endDate: null,
    customerId: null,
    customer: null,
    serviceId: null,
    service: null,
    partnerId: null,
    partnerRef: null,
    reporterId: null,
    reporter: null,
    assigneeId: null,
    assignee: null,
    travelTimeTo: null,
    travelTimeFrom: null,
    watchers: [],
    ...overrides,
  };
}

describe('toTask — legacy-only row (new FKs all NULL)', () => {
  it('maps new FK fields to null', () => {
    const task = toTask(makeBaseRow());
    expect(task.startDate).toBeNull();
    expect(task.endDate).toBeNull();
    expect(task.customerId).toBeNull();
    expect(task.customerName).toBeNull();
    expect(task.serviceId).toBeNull();
    expect(task.partnerId).toBeNull();
    expect(task.reporterId).toBeNull();
    expect(task.assigneeId).toBeNull();
    expect(task.assigneeName).toBeNull();
    expect(task.travelTimeTo).toBeNull();
    expect(task.travelTimeFrom).toBeNull();
  });

  it('maps watchers to empty array when no watchers', () => {
    const task = toTask(makeBaseRow());
    expect(task.watcherIds).toEqual([]);
  });

  it('returns null customerName when customer JOIN is NULL (no legacy fallback — phase 3)', () => {
    const task = toTask(makeBaseRow({ clientName: 'Legacy Name', customer: null }));
    expect(task.customerName).toBeNull();
  });

  it('returns null assigneeName when assignee JOIN is NULL (no legacy fallback — phase 3)', () => {
    const task = toTask(makeBaseRow({ assignedTo: 'Legacy Assignee', assignee: null }));
    expect(task.assigneeName).toBeNull();
  });
});

describe('toTask — FK-resolved row (JOINs populated)', () => {
  it('derives customerName from customer.name JOIN', () => {
    const task = toTask(makeBaseRow({
      customerId: 'cust-1',
      customer: { id: 'cust-1', name: 'Juan García' },
    }));
    expect(task.customerId).toBe('cust-1');
    expect(task.customerName).toBe('Juan García');
  });

  it('derives assigneeName from assignee.name JOIN (prefers JOIN over legacy assignedTo)', () => {
    const task = toTask(makeBaseRow({
      assigneeId: 'admin-1',
      assignee: { id: 'admin-1', name: 'Carlos Técnico' },
      assignedTo: 'Old legacy name', // should be overridden by JOIN
    }));
    expect(task.assigneeId).toBe('admin-1');
    expect(task.assigneeName).toBe('Carlos Técnico');
  });

  it('maps serviceId, partnerId, reporterId when present', () => {
    const task = toTask(makeBaseRow({
      serviceId: 'svc-1',
      service: { id: 'svc-1' },
      partnerId: 'part-1',
      partnerRef: { id: 'part-1' },
      reporterId: 'rep-1',
      reporter: { id: 'rep-1' },
    }));
    expect(task.serviceId).toBe('svc-1');
    expect(task.partnerId).toBe('part-1');
    expect(task.reporterId).toBe('rep-1');
  });

  it('emits startDate as ISO string when Date object', () => {
    const date = new Date('2026-05-21T09:00:00.000Z');
    const task = toTask(makeBaseRow({ startDate: date }));
    expect(typeof task.startDate).toBe('string');
    expect(task.startDate).toBe(date.toISOString());
  });

  it('emits endDate as ISO string when Date object', () => {
    const date = new Date('2026-05-21T11:00:00.000Z');
    const task = toTask(makeBaseRow({ endDate: date }));
    expect(typeof task.endDate).toBe('string');
    expect(task.endDate).toBe(date.toISOString());
  });

  it('maps travelTimeTo and travelTimeFrom', () => {
    const task = toTask(makeBaseRow({ travelTimeTo: 15, travelTimeFrom: 20 }));
    expect(task.travelTimeTo).toBe(15);
    expect(task.travelTimeFrom).toBe(20);
  });
});

describe('toTask — watchers populated', () => {
  it('maps watchers array to watcherIds', () => {
    const task = toTask(makeBaseRow({
      watchers: [
        { taskId: 'task-1', adminId: 'admin-1', admin: { id: 'admin-1' } },
        { taskId: 'task-1', adminId: 'admin-2', admin: { id: 'admin-2' } },
      ],
    }));
    expect(task.watcherIds).toEqual(['admin-1', 'admin-2']);
  });
});
