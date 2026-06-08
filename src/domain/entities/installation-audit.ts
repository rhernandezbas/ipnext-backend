/** Severity of an installation-audit finding. */
export type AuditSeverity = 'ok' | 'warning' | 'critical';
/** Category the finding is about. */
export type AuditCategory = 'señal' | 'conexión' | 'fotos' | 'instalación' | 'otros';

export const AUDIT_SEVERITIES: readonly AuditSeverity[] = ['ok', 'warning', 'critical'];
export const AUDIT_CATEGORIES: readonly AuditCategory[] = ['señal', 'conexión', 'fotos', 'instalación', 'otros'];

/** A single audit finding, persisted under a task's current audit run. */
export interface AuditFinding {
  id: string;
  auditId: string;
  severity: AuditSeverity;
  category: AuditCategory;
  text: string;
  /** Photos the finding refers to (subset of the closure photos); may be empty. */
  photoUrls: string[];
  createdAt: string;
}

/** The current audit run for a task (one per task — replace-on-rerun). */
export interface InstallationAudit {
  id: string;
  taskId: string;
  /** Provider/model that produced it, e.g. "ollama:qwen2.5vl:7b". */
  model: string;
  auditedAt: string;
  findings: AuditFinding[];
}

/** Multimodal context handed to the auditor — closure data + the local task detail. */
export interface AuditContext {
  osCodigo: string;
  technicianName: string | null;
  resultCodeName: string | null;
  /** Non-photo checklist Q/A as readable text (señal values, observaciones, etc.). */
  checklistText: { question: string; answer: string }[];
  technicianNote: string | null;
  materials: { description: string | null; qty: number }[];
  /** ALL closure photo URLs — the adapter downloads + base64-encodes them. */
  photoUrls: string[];
  // ── Detalle de la tarea local (lo pedido vs lo hecho) ──
  taskTitle: string;
  taskDescription: string | null;
  /** Human comments already on the task (the reported problem + back-and-forth). */
  taskComments: string[];
  // ── IClass mirror fields (F6-R7) ──
  /** History transitions with non-empty commentary, last ≤10, each ≤300 chars. */
  historyCommentary: { status: string; commentary: string }[];
  /** Raw commentary log, ≤500 chars; '' when absent. */
  commentaryLog: string;
  /** Internal note, ≤300 chars; '' when absent. */
  internalNote: string;
  /** Equipment events, ≤20 entries. `model` maps from `modelDescription`. */
  equipmentEvents: { type: string | null; serialNumber: string | null; mac: string | null; model: string | null }[];
}

/** What the auditor returns. ok=false ⇒ soft-fail (the use-case persists nothing). */
export interface AuditResult {
  ok: boolean;
  findings: { severity: AuditSeverity; category: AuditCategory; text: string; photoUrls: string[] }[];
}
