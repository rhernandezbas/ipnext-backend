import { InstallationAuditor } from '@domain/ports/InstallationAuditor';
import { TaskAuditRepository } from '@domain/ports/TaskAuditRepository';
import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { TaskCommentRepository } from '@domain/ports/TaskCommentRepository';
import { ClosedServiceOrder } from '@domain/entities/iclass-closed-order';
import { InstallationAudit } from '@domain/entities/installation-audit';
import { buildAuditContext } from '@application/services/buildAuditContext';

export interface AuditInstallationQualityInput {
  taskId: string;
  order: ClosedServiceOrder;
}

/**
 * Audits the installation quality of a closed OS and replaces the task's current
 * audit. Soft-fail aware: if the auditor returns `{ ok: false }` (model down /
 * invalid output), NOTHING is persisted — the prior good audit (if any) survives.
 * An audit with no problems persists a single synthetic `ok` finding so the feed
 * can show an explicit "all clear" state.
 */
export class AuditInstallationQuality {
  constructor(
    private readonly auditor: InstallationAuditor,
    private readonly audits: TaskAuditRepository,
    private readonly scheduling: SchedulingRepository,
    private readonly comments: TaskCommentRepository,
  ) {}

  async execute(input: AuditInstallationQualityInput): Promise<InstallationAudit | null> {
    const task = await this.scheduling.getTask(input.taskId);
    if (!task) return null;
    const comments = await this.comments.listByTask(input.taskId);
    const context = buildAuditContext(input.order, task, comments);

    const result = await this.auditor.audit(context); // never throws
    if (!result.ok) return null; // soft-fail: keep the prior audit, persist nothing

    const findings =
      result.findings.length > 0
        ? result.findings
        : [{ severity: 'ok' as const, category: 'otros' as const, text: 'Instalación sin observaciones.', photoUrls: [] }];

    return this.audits.replaceForTask(input.taskId, this.auditor.provider, { ok: true, findings });
  }
}
