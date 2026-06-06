import { computeUpdateTaskActivities } from '@application/use-cases/computeUpdateTaskActivities';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import type { ScheduledTask } from '@domain/entities/scheduling';
import type { UpdateTaskInput } from '@domain/ports/SchedulingRepository';

const ACTOR = { actorId: 'u1', actorName: 'Alice' };

function prevWith(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return new InMemorySchedulingRepository().seedTask({ id: 'task-1', ...over });
}

function diff(prev: ScheduledTask, data: UpdateTaskInput) {
  return computeUpdateTaskActivities(prev, data, ACTOR);
}

describe('computeUpdateTaskActivities (D.2 diff engine)', () => {
  it('emits nothing when nothing changed (only same-value fields present)', () => {
    const prev = prevWith({ priority: 'normal', notes: 'x' });
    expect(diff(prev, { priority: 'normal', notes: 'x' })).toEqual([]);
  });

  it('ignores fields not present in the partial (undefined)', () => {
    const prev = prevWith({ priority: 'normal' });
    expect(diff(prev, {})).toEqual([]);
  });

  it('priority_changed / category_changed / notes_changed / estimated_hours_changed', () => {
    const prev = prevWith({ priority: 'low', category: 'install', notes: null, estimatedHours: 1 });
    const ev = diff(prev, { priority: 'high', category: 'repair', notes: 'check', estimatedHours: 3 });
    expect(ev).toContainEqual({ type: 'priority_changed', actor: ACTOR, fromValue: 'low', toValue: 'high' });
    expect(ev).toContainEqual({ type: 'category_changed', actor: ACTOR, fromValue: 'install', toValue: 'repair' });
    expect(ev).toContainEqual({ type: 'notes_changed', actor: ACTOR, fromValue: null, toValue: 'check' });
    expect(ev).toContainEqual({ type: 'estimated_hours_changed', actor: ACTOR, fromValue: 1, toValue: 3 });
  });

  it('description_changed / project_changed / reporter_changed', () => {
    const prev = prevWith({ description: null, projectId: null, reporterId: 'r0' });
    const ev = diff(prev, { description: 'd', projectId: 'p1', reporterId: 'r1' });
    expect(ev).toContainEqual({ type: 'description_changed', actor: ACTOR, fromValue: null, toValue: 'd' });
    expect(ev).toContainEqual({ type: 'project_changed', actor: ACTOR, fromValue: null, toValue: 'p1' });
    expect(ev).toContainEqual({ type: 'reporter_changed', actor: ACTOR, fromValue: 'r0', toValue: 'r1' });
  });

  it('contract_changed / customer_changed / partner_changed (FK fields)', () => {
    const prev = prevWith({ contractId: 'c0', customerId: 'cust0', partnerId: null });
    // mirrors the real report: contract removed (set to null)
    const ev = diff(prev, { contractId: null, customerId: 'cust1', partnerId: 'p1' });
    expect(ev).toContainEqual({ type: 'contract_changed', actor: ACTOR, fromValue: 'c0', toValue: null });
    expect(ev).toContainEqual({ type: 'customer_changed', actor: ACTOR, fromValue: 'cust0', toValue: 'cust1' });
    expect(ev).toContainEqual({ type: 'partner_changed', actor: ACTOR, fromValue: null, toValue: 'p1' });
  });

  it('FK changes carry from/to NAMES in metadata when the updated task is provided', () => {
    const prev = prevWith({ projectId: 'p0', projectName: 'Fibra Norte', customerId: 'c0', customerName: 'Acme' });
    const next = prevWith({ projectId: 'p1', projectName: 'Fibra Sur', customerId: 'c1', customerName: 'Globex' });
    const ev = computeUpdateTaskActivities(prev, { projectId: 'p1', customerId: 'c1' }, ACTOR, next);
    expect(ev).toContainEqual({ type: 'project_changed', actor: ACTOR, fromValue: 'p0', toValue: 'p1', metadata: { fromName: 'Fibra Norte', toName: 'Fibra Sur' } });
    expect(ev).toContainEqual({ type: 'customer_changed', actor: ACTOR, fromValue: 'c0', toValue: 'c1', metadata: { fromName: 'Acme', toName: 'Globex' } });
  });

  it('assigned carries the technician name when the updated task is provided', () => {
    const prev = prevWith({ assigneeId: null, assigneeName: null });
    const next = prevWith({ assigneeId: 'u1', assigneeName: 'Juan Pérez' });
    const ev = computeUpdateTaskActivities(prev, { assigneeId: 'u1' }, ACTOR, next);
    expect(ev).toContainEqual({ type: 'assigned', actor: ACTOR, fromValue: null, toValue: 'u1', metadata: { fromName: null, toName: 'Juan Pérez' } });
  });

  it('assigned when going from null → user', () => {
    const ev = diff(prevWith({ assigneeId: null }), { assigneeId: 'a1' });
    expect(ev).toEqual([{ type: 'assigned', actor: ACTOR, fromValue: null, toValue: 'a1' }]);
  });

  it('unassigned when going from user → null', () => {
    const ev = diff(prevWith({ assigneeId: 'a1' }), { assigneeId: null });
    expect(ev).toEqual([{ type: 'unassigned', actor: ACTOR, fromValue: 'a1', toValue: null }]);
  });

  it('assigned with previousAssigneeId when reassigning user → other user', () => {
    const ev = diff(prevWith({ assigneeId: 'a1' }), { assigneeId: 'a2' });
    expect(ev).toEqual([
      { type: 'assigned', actor: ACTOR, fromValue: 'a1', toValue: 'a2', metadata: { previousAssigneeId: 'a1' } },
    ]);
  });

  it('watcher set-diff → one watcher_added per new + one watcher_removed per dropped', () => {
    const ev = diff(prevWith({ watcherIds: ['a', 'b'] }), { watcherIds: ['b', 'c'] });
    expect(ev).toContainEqual({ type: 'watcher_added', actor: ACTOR, toValue: 'c' });
    expect(ev).toContainEqual({ type: 'watcher_removed', actor: ACTOR, fromValue: 'a' });
    expect(ev).toHaveLength(2);
  });

  it('watcher events carry the name from watcherNames when provided (#17)', () => {
    const prev = prevWith({ watcherIds: ['a', 'b'] });
    const watcherNames = { a: 'Ana Gómez', c: 'Carla Ruiz' };
    const ev = computeUpdateTaskActivities(prev, { watcherIds: ['b', 'c'] }, ACTOR, undefined, watcherNames);
    expect(ev).toContainEqual({ type: 'watcher_added', actor: ACTOR, toValue: 'c', metadata: { toName: 'Carla Ruiz' } });
    expect(ev).toContainEqual({ type: 'watcher_removed', actor: ACTOR, fromValue: 'a', metadata: { fromName: 'Ana Gómez' } });
  });

  it('watcher events fall back to no name when the id is not in watcherNames', () => {
    const ev = computeUpdateTaskActivities(prevWith({ watcherIds: ['a'] }), { watcherIds: [] }, ACTOR, undefined, { z: 'Zoe' });
    expect(ev).toEqual([{ type: 'watcher_removed', actor: ACTOR, fromValue: 'a' }]);
  });

  it('due_date_changed once per date field with metadata.field', () => {
    const prev = prevWith({ startDate: null, endDate: '2026-01-01T00:00:00Z' });
    const ev = diff(prev, { startDate: '2026-02-01T00:00:00Z', endDate: '2026-03-01T00:00:00Z' });
    expect(ev).toContainEqual({ type: 'due_date_changed', actor: ACTOR, fromValue: null, toValue: '2026-02-01T00:00:00Z', metadata: { field: 'startDate' } });
    expect(ev).toContainEqual({ type: 'due_date_changed', actor: ACTOR, fromValue: '2026-01-01T00:00:00Z', toValue: '2026-03-01T00:00:00Z', metadata: { field: 'endDate' } });
  });

  it('status_changed (isClosed) and inventory_review_changed (reviewedByInventory)', () => {
    const prev = prevWith({ isClosed: false, reviewedByInventory: false });
    const ev = diff(prev, { isClosed: true, reviewedByInventory: true });
    expect(ev).toContainEqual({ type: 'status_changed', actor: ACTOR, fromValue: false, toValue: true });
    expect(ev).toContainEqual({ type: 'inventory_review_changed', actor: ACTOR, fromValue: false, toValue: true });
  });

  it('address_changed coalesces address + coordinates into ONE event', () => {
    const prev = prevWith({ address: 'Old St', coordinates: null });
    const ev = diff(prev, { address: 'New St', coordinates: { lat: 1, lng: 2 } });
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      type: 'address_changed',
      actor: ACTOR,
      fromValue: { address: 'Old St', coordinates: null },
      toValue: { address: 'New St', coordinates: { lat: 1, lng: 2 } },
    });
  });

  it('travel_time_changed coalesces travelTimeTo + travelTimeFrom into ONE event', () => {
    const prev = prevWith({ travelTimeTo: 10, travelTimeFrom: 20 });
    const ev = diff(prev, { travelTimeTo: 15, travelTimeFrom: 20 });
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      type: 'travel_time_changed',
      fromValue: { travelTimeTo: 10, travelTimeFrom: 20 },
      toValue: { travelTimeTo: 15, travelTimeFrom: 20 },
    });
  });
});
