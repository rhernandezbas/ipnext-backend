import { InstallationAudit, AuditFinding, AuditResult } from '../entities/installation-audit';

export interface TaskAuditRepository {
  /** Atomic replace: delete the prior run (cascade findings) + insert the new one. */
  replaceForTask(taskId: string, model: string, result: AuditResult): Promise<InstallationAudit>;
  /** Flattened findings of the task's current audit run, [] if none. */
  listFindingsByTask(taskId: string): Promise<AuditFinding[]>;
}
