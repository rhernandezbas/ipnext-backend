/**
 * Unit tests for PrismaSchedulingRepository.toTask
 * REQ-NULL-5: description/notes/assignedTo/assignedToId/address map DB null → JS null (not undefined)
 * REQ-STATUS-7: projectName is populated from row.project.title when present
 */
import { toTask } from '../../infrastructure/adapters/prisma/PrismaSchedulingRepository';

describe('PrismaSchedulingRepository.toTask — nullable field mapping (REQ-NULL-5, REQ-NULL-9)', () => {
  it('maps null description to null (not undefined)', () => {
    const row = {
      id: 'test-1',
      sequenceNumber: 1,
      title: 'Test',
      description: null,
      assignedTo: null,
      assignedToId: null,
      clientId: null,
      clientName: null,
      status: 'pending',
      priority: 'normal',
      scheduledDate: '2026-05-10',
      scheduledTime: '09:00',
      estimatedHours: 1,
      address: null,
      lat: null,
      lng: null,
      category: 'other',
      projectId: null,
      project: null,
      completedAt: null,
      notes: null,
    };
    const task = toTask(row);
    expect(task.description).toBeNull();
    expect(task.notes).toBeNull();
    expect(task.assignedTo).toBeNull();
    expect(task.assignedToId).toBeNull();
    expect(task.address).toBeNull();
  });

  it('maps non-null description to a string', () => {
    const row = {
      id: 'test-2',
      sequenceNumber: 2,
      title: 'Test',
      description: 'Some description',
      assignedTo: 'Carlos',
      assignedToId: 'admin-1',
      clientId: null,
      clientName: null,
      status: 'pending',
      priority: 'normal',
      scheduledDate: '2026-05-10',
      scheduledTime: '09:00',
      estimatedHours: 2,
      address: 'Av. Test 123',
      lat: null,
      lng: null,
      category: 'installation',
      projectId: null,
      project: null,
      completedAt: null,
      notes: 'Some notes',
    };
    const task = toTask(row);
    expect(task.description).toBe('Some description');
    expect(task.notes).toBe('Some notes');
    expect(task.assignedTo).toBe('Carlos');
    expect(task.assignedToId).toBe('admin-1');
    expect(task.address).toBe('Av. Test 123');
  });
});

describe('PrismaSchedulingRepository.toTask — projectName mapping (REQ-STATUS-7)', () => {
  it('maps project.title to projectName when project is present', () => {
    const row = {
      id: 'test-3',
      sequenceNumber: 3,
      title: 'Test',
      description: null,
      assignedTo: null,
      assignedToId: null,
      clientId: null,
      clientName: null,
      status: 'pending',
      priority: 'normal',
      scheduledDate: '2026-05-10',
      scheduledTime: '09:00',
      estimatedHours: 1,
      address: null,
      lat: null,
      lng: null,
      category: 'other',
      projectId: 'proj-1',
      project: { title: 'My Project' },
      completedAt: null,
      notes: null,
    };
    const task = toTask(row);
    expect(task.projectName).toBe('My Project');
  });

  it('maps row.sequenceNumber to task.sequenceNumber', () => {
    const row = {
      id: 'test-seq',
      sequenceNumber: 123,
      title: 'X',
      description: null,
      assignedTo: null,
      assignedToId: null,
      clientId: null,
      clientName: null,
      status: 'pending',
      priority: 'normal',
      scheduledDate: '2026-05-10',
      scheduledTime: '09:00',
      estimatedHours: 1,
      address: null,
      lat: null,
      lng: null,
      category: 'other',
      projectId: null,
      project: null,
      completedAt: null,
      notes: null,
    };
    expect(toTask(row).sequenceNumber).toBe(123);
  });

  it('maps null scheduledDate and scheduledTime to null', () => {
    const row = {
      id: 'test-unscheduled',
      sequenceNumber: 42,
      title: 'Pending to schedule',
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
      category: 'other',
      projectId: null,
      project: null,
      completedAt: null,
      notes: null,
    };
    const task = toTask(row);
    expect(task.scheduledDate).toBeNull();
    expect(task.scheduledTime).toBeNull();
  });

  it('maps null project to null projectName', () => {
    const row = {
      id: 'test-4',
      sequenceNumber: 4,
      title: 'Test',
      description: null,
      assignedTo: null,
      assignedToId: null,
      clientId: null,
      clientName: null,
      status: 'pending',
      priority: 'normal',
      scheduledDate: '2026-05-10',
      scheduledTime: '09:00',
      estimatedHours: 1,
      address: null,
      lat: null,
      lng: null,
      category: 'other',
      projectId: null,
      project: null,
      completedAt: null,
      notes: null,
    };
    const task = toTask(row);
    expect(task.projectName).toBeNull();
  });
});
