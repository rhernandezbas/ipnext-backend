import { StageCategory } from './workflow';

/** @deprecated use stageCategory; will be removed next change */
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface ScheduledTask {
  id: string;
  sequenceNumber: number;
  title: string;
  description: string | null;

  /** @deprecated use assigneeId; will be removed in cleanup change */
  assignedTo: string | null;
  /** @deprecated use assigneeId; will be removed in cleanup change */
  assignedToId: string | null;
  /** @deprecated use customerId; will be removed in cleanup change */
  clientId: string | null;
  /** @deprecated use customerName (derived from JOIN); will be removed in cleanup change */
  clientName: string | null;

  stageId: string;                      // primary
  stageCategory: StageCategory;         // read-only derived from Stage
  /** @deprecated use stageCategory; will be removed next change */
  status: TaskStatus;
  priority: TaskPriority;

  /** @deprecated use startDate; will be removed in cleanup change */
  scheduledDate: string | null;
  /** @deprecated use startDate; will be removed in cleanup change */
  scheduledTime: string | null;

  estimatedHours: number;
  address: string | null;
  coordinates: { lat: number; lng: number } | null;
  category: 'installation' | 'repair' | 'maintenance' | 'inspection' | 'other';
  projectId?: string | null;
  projectName?: string | null;
  completedAt: string | null;
  notes: string | null;

  // NEW — datetime envelope
  startDate: string | null;      // ISO 8601 with offset
  endDate: string | null;        // ISO 8601 with offset

  // NEW — FK relations
  customerId: string | null;
  customerName: string | null;   // derived from Client.name via JOIN
  serviceId: string | null;
  partnerId: string | null;
  reporterId: string | null;
  assigneeId: string | null;
  assigneeName: string | null;   // derived from Admin.name via JOIN

  // NEW — watchers
  watcherIds: string[];          // empty array when none

  // NEW — travel time (minutes)
  travelTimeTo: number | null;
  travelTimeFrom: number | null;
}
