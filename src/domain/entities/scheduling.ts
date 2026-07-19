import { StageCategory } from './workflow';
import { TaskChecklistItem } from './checklist';

export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

// #41 — lifecycle management state, independent of workflow stage.
// `open` (default) | `closed` | `dismissed`. Single source of truth; `isClosed` is derived.
export type TaskGeneralStatus = 'open' | 'closed' | 'dismissed';

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
  contractId: string | null;
  // #55 (iclass-contract-code) — short contract code (Contract.grContratoId) used as the
  // IClass customerCode when the task has a contract. Falls back to customerCode when null.
  contractCode: string | null;
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

  // #41 — lifecycle management state. Single source of truth (DB column). Default 'open'.
  generalStatus: TaskGeneralStatus;
  // Flag: task is closed (soft-close, not deleted). Derived: generalStatus === 'closed'.
  isClosed: boolean;

  // RV — Revisado por Inventario: inventory team review flag. Default false.
  reviewedByInventory:         boolean;
  reviewedByInventoryAt:       string | null;   // ISO 8601
  reviewedByInventoryUserName: string | null;   // JOIN-resolved

  // Closure completeness (#14) — per-task flags. closureHasDeviceInventory counts only DEVICE items.
  closureCommentDone:        boolean;
  closureAuditDone:          boolean;
  closureHasDeviceInventory: boolean;

  // network-node-task (#29) — discriminador de tipo de tarea y FK a NetworkSite
  kind: 'customer' | 'network';
  // #66 — Red/FO switch. 'red' = FK to NetworkSite; 'fibra' = free-text node name, no FK.
  // null treated as 'red' for back-compat (existing network tasks).
  networkType: 'red' | 'fibra' | null;
  networkSiteId: string | null;
  // JOIN-derived from NetworkSite.name for red tasks. Stored column for fibra tasks.
  networkSiteName: string | null;

  // #54 — task-level locality snapshot. Required for network tasks. Dispatch precedence:
  // iclassCityCode ?? networkSite?.city ?? null. Null for customer tasks (optional).
  iclassCityCode: string | null;

  // IClass — service order code returned by IClass after a successful "Enviar a IClass". Null otherwise.
  iclassOrderCode: string | null;

  // #39 — whether the task's project allows equipment retirement (false if no project)
  projectAllowsRetirement?: boolean;

  // Gestión Real — upstream service order id this task was ingested from.
  // Null for manually-created tasks. Used as the idempotency key on ingest.
  grOrdenId: string | null;

  // Ticket FK (tickets-actions-be) — optional link to a support ticket.
  ticketId: string | null;
  ticketSubject: string | null;   // JOIN-derived from Ticket.subject — no N+1

  // #86 — archive flag. Null = not archived. Set only when generalStatus is closed/dismissed.
  archivedAt: string | null;

  // noc-broadcast-traceability — última difusión de la tarea al canal NOC (WhatsApp) +
  // nombre (snapshot) del actor que la disparó. Null = nunca difundida.
  lastBroadcastAt: string | null;
  lastBroadcastByName: string | null;

  // K3 (fiber-auto-watcher) — serial de la ONU cargado por el técnico en la tarea de
  // instalación. SIEMPRE normalizado UPPERCASE sin espacios al persistir. No exige
  // prefijo HWTC (ZTE/VSOL se registran igual; el watcher solo auto-aprovisiona Huawei).
  onuSerial: string | null;

  // iclass-status-sync — current IClass OS status code (opaque IClass id, e.g. "7").
  // Null until the scheduler first captures it. Only the code is stored; label/color
  // are resolved by JOIN to IClassStatusCatalog at read time (avoids stale denorm).
  iclassStatusCode: string | null;
  iclassStatusUpdatedAt: string | null;   // ISO 8601 — when the code last changed

  // Resolved at read-path (JOIN to IClassStatusCatalog). Null when no code or no entry.
  iclassStatus: {
    code: string;
    label: string;     // effectiveLabel = displayLabel ?? iclassLabel
    color: string | null;
    tracked: boolean;
  } | null;

  // Timestamps — always present in API responses (ISO 8601 strings)
  createdAt: string;
  updatedAt: string;
}
