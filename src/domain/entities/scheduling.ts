import { StageCategory } from './workflow';
import { TaskChecklistItem } from './checklist';

export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface ScheduledTask {
  id: string;
  sequenceNumber: number;
  title: string;
  description: string | null;

  stageId: string;                      // primary
  stageCategory: StageCategory;         // read-only derived from Stage
  priority: string;   // free text backed by the TaskPriority catalog

  estimatedHours: number;
  address: string | null;
  coordinates: { lat: number; lng: number } | null;
  category: string;   // free text backed by the TaskCategory catalog
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
  customerCity: string | null;   // derived from Client.city via JOIN — for Tasks 'Localidad' column
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

  // NEW — checklist (change 5)
  checklist?: TaskChecklistItem[];

  // Timestamps — always present in API responses (ISO 8601 strings)
  createdAt: string;
  updatedAt: string;
}
