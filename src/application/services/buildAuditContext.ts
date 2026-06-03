import { ClosedServiceOrder } from '@domain/entities/iclass-closed-order';
import { ScheduledTask } from '@domain/entities/scheduling';
import { TaskComment } from '@domain/entities/taskComment';
import { AuditContext } from '@domain/entities/installation-audit';

/**
 * Assembles the multimodal audit context from the closed SO + the local task
 * detail. Pure. The task title/description/comments let the auditor judge "lo
 * pedido vs lo hecho" (the reported problem vs the actual install).
 */
export function buildAuditContext(
  order: ClosedServiceOrder,
  task: ScheduledTask,
  comments: TaskComment[],
): AuditContext {
  const answers = order.checklists.flatMap(c => c.answers);
  return {
    osCodigo: order.iclassCodigo,
    technicianName: order.teamTechnicianName ?? order.closedByName,
    resultCodeName: order.resultCodeName,
    checklistText: answers
      .filter(a => a.questionType !== 'Foto' && a.answerText && a.answerText.trim())
      .map(a => ({ question: a.questionText, answer: (a.answerText as string).trim() })),
    technicianNote: order.technicianNote,
    materials: order.materials.map(m => ({ description: m.materialDescription, qty: m.qty })),
    photoUrls: answers.filter(a => a.photoUrl).map(a => a.photoUrl as string),
    taskTitle: task.title,
    taskDescription: task.description,
    taskComments: comments.map(c => `${c.authorName}: ${c.body}`),
  };
}
