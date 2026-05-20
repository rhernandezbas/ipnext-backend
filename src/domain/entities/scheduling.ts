import { StageCategory } from './workflow';

/** @deprecated use stageCategory; will be removed next change */
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface ScheduledTask {
  id: string;
  sequenceNumber: number;
  title: string;
  description: string | null;
  assignedTo: string | null;
  assignedToId: string | null;
  clientId: string | null;
  clientName: string | null;
  stageId: string;                      // NEW — primary
  stageCategory: StageCategory;         // NEW — read-only derived from Stage
  /** @deprecated use stageCategory; will be removed next change */
  status: TaskStatus;
  priority: TaskPriority;
  scheduledDate: string | null;
  scheduledTime: string | null;
  estimatedHours: number;
  address: string | null;
  coordinates: { lat: number; lng: number } | null;
  category: 'installation' | 'repair' | 'maintenance' | 'inspection' | 'other';
  projectId?: string | null;
  projectName?: string | null;
  completedAt: string | null;
  notes: string | null;
}
