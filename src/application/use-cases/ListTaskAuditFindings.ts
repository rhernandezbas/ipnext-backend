import { TaskAuditRepository } from '@domain/ports/TaskAuditRepository';
import { AuditFindingDto, toAuditFindingDto } from '@application/dto/taskAuditFinding.dto';

/** Lists the findings of a task's current AI installation audit ([] if never audited). */
export class ListTaskAuditFindings {
  constructor(private readonly audits: TaskAuditRepository) {}

  async execute(taskId: string): Promise<AuditFindingDto[]> {
    const findings = await this.audits.listFindingsByTask(taskId);
    return findings.map(toAuditFindingDto);
  }
}
