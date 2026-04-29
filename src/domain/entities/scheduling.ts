export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface ScheduledTask {
  id: string;
  title: string;
  description: string;
  assignedTo: string;
  assignedToId: string;
  clientId: string | null;
  clientName: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  scheduledDate: string;
  scheduledTime: string;
  estimatedHours: number;
  address: string;
  coordinates: { lat: number; lng: number } | null;
  category: 'installation' | 'repair' | 'maintenance' | 'inspection' | 'other';
  completedAt: string | null;
  notes: string;
}
