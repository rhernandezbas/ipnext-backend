import { TaskAuditRepository } from '@domain/ports/TaskAuditRepository';
import { InstallationAudit, AuditFinding, AuditResult, AuditSeverity, AuditCategory } from '@domain/entities/installation-audit';
import { prisma } from '../../database/prisma';
import { randomUUID } from 'crypto';

type FindingRow = { id: string; auditId: string; severity: string; category: string; text: string; photoUrls: string[]; createdAt: Date };
type AuditRow = { id: string; taskId: string; model: string; auditedAt: Date; findings: FindingRow[] };

const toFinding = (r: FindingRow): AuditFinding => ({
  id: r.id, auditId: r.auditId, severity: r.severity as AuditSeverity, category: r.category as AuditCategory,
  text: r.text, photoUrls: r.photoUrls, createdAt: r.createdAt.toISOString(),
});

const toAudit = (r: AuditRow): InstallationAudit => ({
  id: r.id, taskId: r.taskId, model: r.model, auditedAt: r.auditedAt.toISOString(), findings: r.findings.map(toFinding),
});

export class PrismaTaskAuditRepository implements TaskAuditRepository {
  /** Atomic replace: drop the prior run (cascades findings) + insert the new one. */
  async replaceForTask(taskId: string, model: string, result: AuditResult): Promise<InstallationAudit> {
    const auditId = randomUUID();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (prisma as any).$transaction(async (tx: any) => {
      await tx.taskInstallationAudit.deleteMany({ where: { taskId } });
      await tx.taskInstallationAudit.create({
        data: {
          id: auditId, taskId, model,
          findings: {
            create: result.findings.map(f => ({ severity: f.severity, category: f.category, text: f.text, photoUrls: f.photoUrls })),
          },
        },
      });
    });
    const row = await prisma.taskInstallationAudit.findUnique({ where: { id: auditId }, include: { findings: { orderBy: { createdAt: 'asc' } } } });
    return toAudit(row as AuditRow);
  }

  async listFindingsByTask(taskId: string): Promise<AuditFinding[]> {
    const audit = await prisma.taskInstallationAudit.findUnique({
      where: { taskId },
      include: { findings: { orderBy: { createdAt: 'asc' } } },
    });
    return audit ? (audit.findings as FindingRow[]).map(toFinding) : [];
  }
}
