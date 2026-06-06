import { InstallationAuditor } from '@domain/ports/InstallationAuditor';
import { TaskAuditRepository } from '@domain/ports/TaskAuditRepository';
import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { TaskCommentRepository } from '@domain/ports/TaskCommentRepository';
import { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import { ClosedServiceOrder } from '@domain/entities/iclass-closed-order';
import { InstallationAudit } from '@domain/entities/installation-audit';
import { buildAuditContext } from '@application/services/buildAuditContext';

/** DB-backed feature flag gating the AI installation audit (default OFF, runtime-toggleable). */
export const AUDIT_FLAG_KEY = 'iclass-audit';

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
    private readonly flags: FeatureFlagRepository,
  ) {}

  async execute(input: AuditInstallationQualityInput): Promise<InstallationAudit | null> {
    const flag = await this.flags.get(AUDIT_FLAG_KEY);
    if (!flag?.enabled) {
      // Auditoría apagada por flag (default OFF) — no se llama al modelo ni se persiste nada.
      return null;
    }
    const task = await this.scheduling.getTask(input.taskId);
    if (!task) {
      // eslint-disable-next-line no-console
      console.warn(`[audit] task ${input.taskId} no existe — se omite la auditoría`);
      return null;
    }
    const comments = await this.comments.listByTask(input.taskId);
    const context = buildAuditContext(input.order, task, comments);

    const result = await this.auditor.audit(context); // never throws
    if (!result.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[audit] task ${input.taskId}: el auditor devolvió ok=false — no se persiste nada`);
      return null; // soft-fail: keep the prior audit, persist nothing
    }

    const findings =
      result.findings.length > 0
        ? result.findings
        : [{ severity: 'ok' as const, category: 'otros' as const, text: 'Instalación sin observaciones.', photoUrls: [] }];

    const saved = await this.audits.replaceForTask(input.taskId, this.auditor.provider, { ok: true, findings });
    // eslint-disable-next-line no-console
    console.log(`[audit] task ${input.taskId}: auditoría guardada (${findings.length} hallazgos)`);
    return saved;
  }
}
