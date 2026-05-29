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
  customerPhone: string | null;  // derived from Client.phone via JOIN — required field for IClass OS
  // Short, stable client code used as IClass customerCode. Derived: grClienteId ?? splynxId ?? login.
  // The UUID customerId is NOT valid as an IClass code (exceeds its char limit → ICLERR_0045).
  customerCode: string | null;
  serviceId: string | null;
  partnerId: string | null;
  reporterId: string | null;
  reporterName: string | null;   // derived from RbacUser.name via JOIN
  assigneeId: string | null;
  assigneeName: string | null;   // derived from RbacUser.name via JOIN

  // NEW — watchers
  watcherIds: string[];          // empty array when none

  // NEW — travel time (minutes)
  travelTimeTo: number | null;
  travelTimeFrom: number | null;

  // NEW — checklist (change 5)
  checklist?: TaskChecklistItem[];

  // Flag: task is closed (soft-close, not deleted). Default false.
  isClosed: boolean;

  // RV — Revisado por Inventario: inventory team review flag. Default false.
  reviewedByInventory: boolean;

  // IClass — service order code returned by IClass after a successful "Enviar a IClass". Null otherwise.
  iclassOrderCode: string | null;

  // Timestamps — always present in API responses (ISO 8601 strings)
  createdAt: string;
  updatedAt: string;
}
