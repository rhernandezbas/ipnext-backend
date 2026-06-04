/**
 * Task activity log (audit feed) — domain entity.
 *
 * A `TaskActivity` is one immutable audit entry on a ScheduledTask: who did what,
 * when, and the before/after values. The feed is append-only; entries are never
 * mutated. `actorName` is a SNAPSHOT (survives a later user rename/delete) and
 * `actorId` is a soft FK to RbacUser (SetNull on delete).
 */

export type ActivityType =
  | 'created'
  | 'stage_changed'
  | 'priority_changed'
  | 'category_changed'
  | 'assigned'
  | 'unassigned'
  | 'reporter_changed'
  | 'contract_changed'
  | 'customer_changed'
  | 'partner_changed'
  | 'watcher_added'
  | 'watcher_removed'
  | 'commented'
  | 'comment_deleted'
  | 'attachment_added'
  | 'attachment_removed'
  | 'status_changed'
  | 'due_date_changed'
  | 'description_changed'
  | 'project_changed'
  | 'address_changed'
  | 'estimated_hours_changed'
  | 'travel_time_changed'
  | 'notes_changed'
  | 'inventory_review_changed'
  | 'sent_to_iclass'
  | 'checklist_item_added'
  | 'checklist_item_removed'
  | 'checklist_item_toggled'
  | 'checklist_item_updated'
  | 'checklist_reordered'
  | 'checklist_template_assigned'
  | 'checklist_cleared';

export interface TaskActivity {
  id: string;
  taskId: string;
  type: ActivityType;
  /** Soft FK to RbacUser. Null for system/automatic actions. */
  actorId: string | null;
  /** Snapshot of the actor's display name at the time of the action. */
  actorName: string;
  fromValue: unknown;
  toValue: unknown;
  metadata: Record<string, unknown> | null;
  /** ISO timestamp. */
  createdAt: string;
}
