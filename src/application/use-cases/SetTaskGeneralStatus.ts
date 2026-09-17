import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { ScheduledTask, TaskGeneralStatus } from '@domain/entities/scheduling';
import { TaskNotFoundError, InvalidGeneralStatusError } from '@domain/errors/scheduling';
import { TaskActivityRecorder, ActorContext } from '@domain/ports/TaskActivityRecorder';
import { SYSTEM_ACTOR } from './taskActivityActor';
import { applyTaskClosure } from './applyTaskClosure';
import { readClearedClosureStamp, clearedClosureMetadata } from './reopenClosureStamp';
import { PushIClassClosureOnTaskEnd } from './PushIClassClosureOnTaskEnd';

const VALID_STATUSES: readonly TaskGeneralStatus[] = ['open', 'closed', 'dismissed'];

/**
 * #41 — Set a task's lifecycle management status (open / closed / dismissed).
 *
 * Single writer for generalStatus via the dedicated endpoint. Free transitions
 * (any → any). Idempotent (D8): a no-op transition returns the task and emits no
 * activity. The recorded `status_changed` event carries STRING from/to values.
 */
export class SetTaskGeneralStatus {
  constructor(
    private readonly repo: SchedulingRepository,
    private readonly recorder?: TaskActivityRecorder,
    /** Optional best-effort push of the IClass closure when the task ends (AD-2 style). */
    private readonly iclassClosurePush?: PushIClassClosureOnTaskEnd,
  ) {}

  async execute(id: string, status: string, actor?: ActorContext): Promise<ScheduledTask> {
    // Defensive validation (the route's zod guard already rejects bad values 400).
    if (!VALID_STATUSES.includes(status as TaskGeneralStatus)) {
      throw new InvalidGeneralStatusError(status);
    }

    const prev = await this.repo.getTask(id);
    if (!prev) throw new TaskNotFoundError(id);

    // D8 — idempotent no-op: same status returns the task without an event.
    if (prev.generalStatus === status) return prev;

    // wave-1a (cierre atómico) — a transition INTO 'closed' is the one with a real
    // race (staff/iclass/app can all close concurrently), so it routes through the
    // atomic guard. Losing the race is NOT an error: the same guard already decided
    // a winner (possibly this very millisecond, between the read above and now) —
    // we just return whatever won, emit no event of our own, and let
    // applyTaskClosure log/record the discrepancy if the resultCodes differ.
    if (status === 'closed') {
      const result = await applyTaskClosure(this.repo, this.recorder, {
        taskId: id,
        origin: 'staff',
        resultCode: null,
        closedByUserId: actor?.actorId ?? null,
      });
      const updated = result.task ?? await this.repo.getTask(id);
      if (!updated) throw new TaskNotFoundError(id);

      if (result.closed && this.recorder) {
        await this.recorder.record(id, 'status_changed', {
          actor: actor ?? SYSTEM_ACTOR,
          fromValue: prev.generalStatus,
          toValue: status,
        });
      }
      // Best-effort IClass push — ONLY when THIS call actually won the closure race,
      // and with `prev` (the task as it was BEFORE the change, still carrying its
      // iclassOrderCode untouched by the write above).
      if (result.closed && this.iclassClosurePush) {
        void this.iclassClosurePush.execute(prev, 'closed', actor?.actorName ?? 'Sistema');
      }
      return updated;
    }

    // FIX-C (fix wave 2 W1a) — el sello de cierre se lee ANTES del write que lo borra
    // (FIX-1 limpia las cuatro columnas en toda transición a un estado != 'closed').
    // Sin recorder no hay a dónde guardarlo, así que tampoco se hace la query.
    const clearedClosure = this.recorder
      ? await readClearedClosureStamp(this.repo, id, prev.generalStatus, status as TaskGeneralStatus)
      : null;

    const updated = await this.repo.updateTask(id, { generalStatus: status as TaskGeneralStatus });
    if (!updated) throw new TaskNotFoundError(id);

    if (this.recorder) {
      const metadata = clearedClosureMetadata(clearedClosure);
      await this.recorder.record(id, 'status_changed', {
        actor: actor ?? SYSTEM_ACTOR,
        fromValue: prev.generalStatus,
        toValue: status,
        ...(metadata ? { metadata } : {}),
      });
    }

    // Best-effort IClass push on a real transition INTO 'dismissed' (not raced — this
    // branch always writes unconditionally, so reaching it means this call is the one
    // that made the change).
    if (status === 'dismissed' && this.iclassClosurePush) {
      void this.iclassClosurePush.execute(prev, 'dismissed', actor?.actorName ?? 'Sistema');
    }

    return updated;
  }
}
