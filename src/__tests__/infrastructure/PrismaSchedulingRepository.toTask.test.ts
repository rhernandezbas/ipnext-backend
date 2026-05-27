/**
 * Unit tests for PrismaSchedulingRepository.toTask
 * Phase 3: legacy fields (assignedTo, assignedToId, clientId, clientName,
 *          scheduledDate, scheduledTime, status) are no longer in the output.
 * REQ-STATUS-7: projectName is populated from row.project.title when present
 * customerName/assigneeName come ONLY from JOIN (no legacy fallback)
 */
import { toTask } from '../../infrastructure/adapters/prisma/PrismaSchedulingRepository';

// Minimal row shape (no legacy fields passed in)
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
  serviceId: null,
  partnerId: null,
  reporterId: null,
  assigneeId: null,
  assignee: null,
  watchers: [],
  checklist: [],
  travelTimeTo: null,
  travelTimeFrom: null,
  createdAt: new Date('2026-05-01T00:00:00Z'),
  updatedAt: new Date('2026-05-01T00:00:00Z'),
};

describe('PrismaSchedulingRepository.toTask — nullable field mapping (REQ-NULL-5, REQ-NULL-9)', () => {
  it('maps null description to null (not undefined)', () => {
    const task = toTask({ ...BASE_ROW });
    expect(task.description).toBeNull();
    expect(task.notes).toBeNull();
    expect(task.address).toBeNull();
  });

  it('maps non-null description to a string', () => {
    const task = toTask({ ...BASE_ROW, description: 'Some description', address: 'Av. Test 123', notes: 'Some notes' });
    expect(task.description).toBe('Some description');
    expect(task.notes).toBe('Some notes');
    expect(task.address).toBe('Av. Test 123');
  });

  it('does NOT expose legacy fields in output', () => {
    const task = toTask({ ...BASE_ROW, assignedTo: 'legacy', clientName: 'legacy client' });
    expect(task).not.toHaveProperty('assignedTo');
    expect(task).not.toHaveProperty('assignedToId');
    expect(task).not.toHaveProperty('clientId');
    expect(task).not.toHaveProperty('clientName');
    expect(task).not.toHaveProperty('scheduledDate');
    expect(task).not.toHaveProperty('scheduledTime');
    expect(task).not.toHaveProperty('status');
  });
});

describe('PrismaSchedulingRepository.toTask — customerName/assigneeName from JOIN only', () => {
  it('customerName comes from customer JOIN, not legacy clientName', () => {
    const task = toTask({
      ...BASE_ROW,
      customer: { id: 'c-1', name: 'Juan García', city: 'Rosario' },
      clientName: 'SHOULD BE IGNORED',
    });
    expect(task.customerName).toBe('Juan García');
    expect(task.customerCity).toBe('Rosario');
  });

  it('customerName is null when customerId is null (no JOIN)', () => {
    const task = toTask({ ...BASE_ROW, customer: null, clientName: 'LEGACY' });
    expect(task.customerName).toBeNull();
  });

  it('assigneeName comes from assignee JOIN, not legacy assignedTo', () => {
    const task = toTask({
      ...BASE_ROW,
      assignee: { id: 'a-1', name: 'Carlos Técnico' },
      assignedTo: 'SHOULD BE IGNORED',
    });
    expect(task.assigneeName).toBe('Carlos Técnico');
  });

  it('assigneeName is null when assigneeId is null (no JOIN)', () => {
    const task = toTask({ ...BASE_ROW, assignee: null, assignedTo: 'LEGACY' });
    expect(task.assigneeName).toBeNull();
  });
});

describe('PrismaSchedulingRepository.toTask — projectName mapping (REQ-STATUS-7)', () => {
  it('maps project.title to projectName when project is present', () => {
    const task = toTask({ ...BASE_ROW, projectId: 'proj-1', project: { title: 'My Project' } });
    expect(task.projectName).toBe('My Project');
  });

  it('maps null project to null projectName', () => {
    const task = toTask({ ...BASE_ROW, project: null });
    expect(task.projectName).toBeNull();
  });

  it('maps row.sequenceNumber to task.sequenceNumber', () => {
    const task = toTask({ ...BASE_ROW, sequenceNumber: 123 });
    expect(task.sequenceNumber).toBe(123);
  });
});
