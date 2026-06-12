/**
 * A4.1 [RED] Tests para el mapeo de kind/networkSiteId/networkSiteName en
 * PrismaSchedulingRepository.toTask y _buildCreateData.
 * Cubre REQ-SHAPE-2.
 * #66 — extended to cover networkType + fibra networkSiteName stored column.
 */
import { toTask } from '../../infrastructure/adapters/prisma/PrismaSchedulingRepository';

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
  partnerId: null,
  reporterId: null,
  assigneeId: null,
  assignee: null,
  reporter: null,
  watchers: [],
  checklist: [],
  travelTimeTo: null,
  travelTimeFrom: null,
  createdAt: new Date('2026-05-01T00:00:00Z'),
  updatedAt: new Date('2026-05-01T00:00:00Z'),
  ticket: null,
  ticketId: null,
  reviewedByInventoryUser: null,
  isClosed: false,
  reviewedByInventory: false,
  reviewedByInventoryAt: null,
  closureCommentDone: false,
  closureAuditDone: false,
  closureHasDeviceInventory: false,
  iclassOrderCode: null,
  grOrdenId: null,
};

describe('PrismaSchedulingRepository.toTask — network-node-task fields (REQ-SHAPE-2)', () => {
  it('maps kind=customer from DB row (default case)', () => {
    const task = toTask({ ...BASE_ROW, kind: 'customer', networkSiteId: null, networkSite: null });
    expect(task.kind).toBe('customer');
    expect(task.networkSiteId).toBeNull();
    expect(task.networkSiteName).toBeNull();
    expect(task.networkType).toBeNull();
  });

  it('maps kind=network (red) with networkSiteId and networkSiteName from JOIN', () => {
    const task = toTask({
      ...BASE_ROW,
      kind: 'network',
      networkType: 'red',
      networkSiteId: 'site-abc',
      networkSite: { id: 'site-abc', name: 'Torre Norte' },
      networkSiteName: null, // stored column null — JOIN wins
    });
    expect(task.kind).toBe('network');
    expect(task.networkType).toBe('red');
    expect(task.networkSiteId).toBe('site-abc');
    // JOIN-derived wins over stored column for red tasks
    expect(task.networkSiteName).toBe('Torre Norte');
  });

  it('networkSiteName is null when networkSite JOIN is null and stored column is null', () => {
    const task = toTask({ ...BASE_ROW, kind: 'network', networkType: 'red', networkSiteId: 'site-abc', networkSite: null, networkSiteName: null });
    expect(task.networkSiteName).toBeNull();
  });

  it('#66 — fibra: networkSiteName comes from stored column when JOIN is null', () => {
    const task = toTask({
      ...BASE_ROW,
      kind: 'network',
      networkType: 'fibra',
      networkSiteId: null,     // fibra: no FK
      networkSite: null,       // fibra: no JOIN
      networkSiteName: 'Nodo FO-1', // stored column
    });
    expect(task.kind).toBe('network');
    expect(task.networkType).toBe('fibra');
    expect(task.networkSiteId).toBeNull();
    expect(task.networkSiteName).toBe('Nodo FO-1');
  });

  it('#66 — red: JOIN name wins over stored column', () => {
    const task = toTask({
      ...BASE_ROW,
      kind: 'network',
      networkType: 'red',
      networkSiteId: 'site-abc',
      networkSite: { id: 'site-abc', name: 'JOIN Name' },
      networkSiteName: 'Stored Name', // should be ignored — JOIN wins for red
    });
    expect(task.networkSiteName).toBe('JOIN Name');
  });

  it('defaults kind to customer when column is absent (legacy rows)', () => {
    // Sin campo kind (filas anteriores a la migración) → default 'customer'
    const task = toTask({ ...BASE_ROW });
    expect(task.kind).toBe('customer');
    expect(task.networkSiteId).toBeNull();
    expect(task.networkSiteName).toBeNull();
    expect(task.networkType).toBeNull();
  });

  it('networkType is null for legacy rows (pre-#66 migration)', () => {
    const task = toTask({ ...BASE_ROW, kind: 'network', networkType: null, networkSiteId: 'site-abc', networkSite: null, networkSiteName: null });
    expect(task.networkType).toBeNull();
  });
});
