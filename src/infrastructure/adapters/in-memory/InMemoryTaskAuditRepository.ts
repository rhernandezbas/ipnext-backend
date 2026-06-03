import { TaskAuditRepository } from '@domain/ports/TaskAuditRepository';
import { InstallationAudit, AuditFinding, AuditResult } from '@domain/entities/installation-audit';
import { randomUUID } from 'crypto';

/** In-memory TaskAuditRepository for use-case tests. Replace = overwrite by taskId. */
export class InMemoryTaskAuditRepository implements TaskAuditRepository {
  readonly byTask = new Map<string, InstallationAudit>();

  async replaceForTask(taskId: string, model: string, result: AuditResult): Promise<InstallationAudit> {
    const auditId = randomUUID();
    const now = new Date().toISOString();
    const audit: InstallationAudit = {
      id: auditId,
      taskId,
      model,
      auditedAt: now,
      findings: result.findings.map(f => ({ id: randomUUID(), auditId, ...f, createdAt: now })),
    };
    this.byTask.set(taskId, audit);
    return audit;
  }

  async listFindingsByTask(taskId: string): Promise<AuditFinding[]> {
    return this.byTask.get(taskId)?.findings ?? [];
  }
}
