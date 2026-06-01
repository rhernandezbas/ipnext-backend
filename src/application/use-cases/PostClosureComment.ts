import { TaskCommentRepository } from '@domain/ports/TaskCommentRepository';
import { TaskComment, TaskCommentAttachment } from '@domain/entities/taskComment';
import { ClosedServiceOrder } from '@domain/entities/iclass-closed-order';
import { randomUUID } from 'crypto';

/** Author shown on auto-generated closure comments (distinguishes from humans). */
export const ICLASS_SYSTEM_AUTHOR = 'Sistema IClass';

export interface PostClosureCommentInput {
  /** Local task matched to the closed OS. */
  taskId: string;
  /** The mirrored closed-SO aggregate (checklists may carry photoUrl post-correlation). */
  order: ClosedServiceOrder;
  /** Extra attachment URLs from the SEAM scrape (e.g. the signature). */
  attachmentUrls?: string[];
}

/**
 * Posts a readable `TaskComment` on the task when its IClass OS closes: the
 * technician's text/choice checklist answers + motivo + técnico, with the
 * checklist photos and signature linked as attachments (by URL — not downloaded).
 *
 * Idempotent: one closure comment per task. A second run is a no-op (returns null).
 */
export class PostClosureComment {
  constructor(private readonly comments: TaskCommentRepository) {}

  async execute(input: PostClosureCommentInput): Promise<TaskComment | null> {
    const { taskId, order } = input;

    const existing = await this.comments.listByTask(taskId);
    if (existing.some(c => c.authorName === ICLASS_SYSTEM_AUTHOR)) return null;

    const commentId = randomUUID();
    const urls = collectAttachmentUrls(order, input.attachmentUrls ?? []);
    const attachments: TaskCommentAttachment[] = urls.map(url => ({
      id: randomUUID(),
      commentId,
      url,
      filename: fileNameFromUrl(url),
      mimeType: null,
      sizeBytes: null,
    }));

    const comment: TaskComment = {
      id: commentId,
      taskId,
      authorName: ICLASS_SYSTEM_AUTHOR,
      body: buildBody(order),
      createdAt: new Date().toISOString(),
      attachments,
    };
    return this.comments.create(comment);
  }
}

/** Human-readable closure summary. */
function buildBody(o: ClosedServiceOrder): string {
  const lines: string[] = [`Cierre IClass — OS ${o.iclassCodigo}`];
  const tech = o.closedByName ?? o.teamTechnicianName;
  if (tech) lines.push(`Técnico: ${tech}`);
  if (o.resultCodeName) lines.push(`Motivo: ${o.resultCodeName}`);

  const qa: string[] = [];
  for (const c of o.checklists) {
    for (const a of c.answers) {
      if (a.questionType !== 'Foto' && a.answerText && a.answerText.trim()) {
        qa.push(`• ${a.questionText}: ${a.answerText.trim()}`);
      }
    }
  }
  if (qa.length) lines.push('', 'Checklist:', ...qa);

  if (o.technicianNote && o.technicianNote.trim()) {
    lines.push('', `Observaciones: ${o.technicianNote.trim()}`);
  }
  return lines.join('\n');
}

/** Checklist photo URLs (post-correlation) + extra scrape attachments (signature). */
function collectAttachmentUrls(o: ClosedServiceOrder, extra: string[]): string[] {
  const urls: string[] = [];
  for (const c of o.checklists) {
    for (const a of c.answers) {
      if (a.photoUrl) urls.push(a.photoUrl);
    }
  }
  urls.push(...extra);
  return urls;
}

function fileNameFromUrl(url: string): string {
  const seg = url.split('?')[0].split('/').pop();
  return seg && seg.length ? seg : 'adjunto.jpg';
}
