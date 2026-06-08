import { ClosedServiceOrder } from '@domain/entities/iclass-closed-order';
import { ScheduledTask } from '@domain/entities/scheduling';
import { TaskComment } from '@domain/entities/taskComment';
import { AuditContext } from '@domain/entities/installation-audit';

// ── Trimming budgets (F6-R7) ─────────────────────────────────────────────────
/** Keep the last N commentary-bearing history entries. */
export const HISTORY_MAX_ENTRIES = 10;
/** Max chars per individual history commentary string. */
export const HISTORY_COMMENTARY_MAX_CHARS = 300;
/** Max chars for the raw commentary log. */
export const COMMENTARY_LOG_MAX_CHARS = 500;
/** Max chars for the internal note. */
export const INTERNAL_NOTE_MAX_CHARS = 300;
/** Max equipment-event entries passed to the auditor. */
export const EQUIPMENT_EVENTS_MAX = 20;

/** Slice string to max length. Safe on empty/null via default ''. */
function truncate(s: string, max: number): string {
  return s.slice(0, max);
}

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

  // history entries that have non-empty commentary, keeping the last HISTORY_MAX_ENTRIES
  const historyCommentary = order.history
    .filter(h => h.commentary && h.commentary.trim())
    .slice(-HISTORY_MAX_ENTRIES)
    .map(h => ({
      status: h.statusDescription,
      commentary: truncate(h.commentary as string, HISTORY_COMMENTARY_MAX_CHARS),
    }));

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
    historyCommentary,
    commentaryLog: truncate(order.commentaryLog ?? '', COMMENTARY_LOG_MAX_CHARS),
    internalNote: truncate(order.internalNote ?? '', INTERNAL_NOTE_MAX_CHARS),
    equipmentEvents: order.equipmentEvents.slice(0, EQUIPMENT_EVENTS_MAX).map(e => ({
      type: e.type,
      serialNumber: e.serialNumber,
      mac: e.mac,
      model: e.modelDescription,
    })),
  };
}
