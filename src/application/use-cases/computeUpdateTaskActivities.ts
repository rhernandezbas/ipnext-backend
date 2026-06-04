import type { ScheduledTask } from '@domain/entities/scheduling';
import type { UpdateTaskInput } from '@domain/ports/SchedulingRepository';
import type { ActivityType } from '@domain/entities/taskActivity';
import type { ActorContext } from '@domain/ports/TaskActivityRecorder';

export interface TaskActivityEvent {
  type: ActivityType;
  actor: ActorContext;
  fromValue?: unknown;
  toValue?: unknown;
  metadata?: Record<string, unknown> | null;
}

/**
 * Diff engine for UpdateTask (#10 / D.2). Compares the PREVIOUS task against the
 * incoming partial and emits 0..N activity events — one per changed field family.
 * Only fields PRESENT in the partial (not `undefined`) are considered; a field
 * set to the same value emits nothing. Some families coalesce multiple columns
 * into a single event (address+coordinates, travelTimeTo+travelTimeFrom).
 */
export function computeUpdateTaskActivities(
  prev: ScheduledTask,
  data: UpdateTaskInput,
  actor: ActorContext,
  /** The task AFTER the update — used to resolve the new `to` names for FK fields. */
  next?: ScheduledTask,
): TaskActivityEvent[] {
  const events: TaskActivityEvent[] = [];
  const d = data as Record<string, unknown>;
  const p = prev as unknown as Record<string, unknown>;
  const changed = (field: string): boolean => d[field] !== undefined && d[field] !== p[field];

  // Human-readable from/to names for FK fields (omitted when `next` is absent, e.g. unit tests).
  const names = (fromName: string | null | undefined, toName: string | null | undefined) =>
    next ? { fromName: fromName ?? null, toName: toName ?? null } : undefined;

  // ── Simple scalar fields ──
  if (changed('priority')) events.push({ type: 'priority_changed', actor, fromValue: prev.priority, toValue: data.priority });
  if (changed('category')) events.push({ type: 'category_changed', actor, fromValue: prev.category, toValue: data.category });
  if (changed('description')) events.push({ type: 'description_changed', actor, fromValue: prev.description, toValue: data.description });
  if (changed('notes')) events.push({ type: 'notes_changed', actor, fromValue: prev.notes, toValue: data.notes });
  if (changed('estimatedHours')) events.push({ type: 'estimated_hours_changed', actor, fromValue: prev.estimatedHours, toValue: data.estimatedHours });
  if (changed('projectId')) events.push({ type: 'project_changed', actor, fromValue: prev.projectId ?? null, toValue: data.projectId, metadata: names(prev.projectName, next?.projectName) });
  if (changed('reporterId')) events.push({ type: 'reporter_changed', actor, fromValue: prev.reporterId, toValue: data.reporterId, metadata: names(prev.reporterName, next?.reporterName) });
  if (changed('contractId')) events.push({ type: 'contract_changed', actor, fromValue: prev.contractId, toValue: data.contractId });
  if (changed('customerId')) events.push({ type: 'customer_changed', actor, fromValue: prev.customerId, toValue: data.customerId, metadata: names(prev.customerName, next?.customerName) });
  if (changed('partnerId')) events.push({ type: 'partner_changed', actor, fromValue: prev.partnerId, toValue: data.partnerId });
  if (changed('isClosed')) events.push({ type: 'status_changed', actor, fromValue: prev.isClosed, toValue: data.isClosed });
  if (changed('reviewedByInventory')) events.push({ type: 'inventory_review_changed', actor, fromValue: prev.reviewedByInventory, toValue: data.reviewedByInventory });

  // ── Assignee → assigned / unassigned ──
  if (data.assigneeId !== undefined && data.assigneeId !== prev.assigneeId) {
    if (data.assigneeId === null) {
      events.push({ type: 'unassigned', actor, fromValue: prev.assigneeId, toValue: null });
    } else if (prev.assigneeId === null) {
      events.push({ type: 'assigned', actor, fromValue: null, toValue: data.assigneeId });
    } else {
      events.push({ type: 'assigned', actor, fromValue: prev.assigneeId, toValue: data.assigneeId, metadata: { previousAssigneeId: prev.assigneeId } });
    }
  }

  // ── Watchers → set diff ──
  if (data.watcherIds !== undefined) {
    const prevSet = new Set(prev.watcherIds);
    const nextSet = new Set(data.watcherIds);
    for (const id of data.watcherIds) if (!prevSet.has(id)) events.push({ type: 'watcher_added', actor, toValue: id });
    for (const id of prev.watcherIds) if (!nextSet.has(id)) events.push({ type: 'watcher_removed', actor, fromValue: id });
  }

  // ── Due dates → one event per field, with metadata.field ──
  if (changed('startDate')) events.push({ type: 'due_date_changed', actor, fromValue: prev.startDate, toValue: data.startDate, metadata: { field: 'startDate' } });
  if (changed('endDate')) events.push({ type: 'due_date_changed', actor, fromValue: prev.endDate, toValue: data.endDate, metadata: { field: 'endDate' } });

  // ── Address + coordinates → coalesced into ONE event ──
  const addrChanged = data.address !== undefined && data.address !== prev.address;
  const coordsChanged = data.coordinates !== undefined && !coordsEqual(data.coordinates, prev.coordinates);
  if (addrChanged || coordsChanged) {
    events.push({
      type: 'address_changed',
      actor,
      fromValue: { address: prev.address, coordinates: prev.coordinates },
      toValue: {
        address: addrChanged ? data.address : prev.address,
        coordinates: coordsChanged ? data.coordinates : prev.coordinates,
      },
    });
  }

  // ── Travel time (to + from) → coalesced into ONE event ──
  const ttToChanged = data.travelTimeTo !== undefined && data.travelTimeTo !== prev.travelTimeTo;
  const ttFromChanged = data.travelTimeFrom !== undefined && data.travelTimeFrom !== prev.travelTimeFrom;
  if (ttToChanged || ttFromChanged) {
    events.push({
      type: 'travel_time_changed',
      actor,
      fromValue: { travelTimeTo: prev.travelTimeTo, travelTimeFrom: prev.travelTimeFrom },
      toValue: {
        travelTimeTo: ttToChanged ? data.travelTimeTo : prev.travelTimeTo,
        travelTimeFrom: ttFromChanged ? data.travelTimeFrom : prev.travelTimeFrom,
      },
    });
  }

  return events;
}

function coordsEqual(
  a: { lat: number; lng: number } | null | undefined,
  b: { lat: number; lng: number } | null,
): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return a.lat === b.lat && a.lng === b.lng;
}
