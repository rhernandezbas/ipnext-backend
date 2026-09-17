import { IClassPort } from '@domain/ports/IClassPort';
import { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import { ScheduledTask } from '@domain/entities/scheduling';
import { ICLASS_COMPLETED_IN_PROMINENSE, ICLASS_CANCELLED_IN_PROMINENSE } from './iclassProminenseResultCodes';

/** IClass terminal statusCode — the OS is already closed. */
const ICLASS_STATUS_CLOSED = '7';
/** IClass statusCode — the technician already closed it from the field app (awaiting office approval). */
const ICLASS_STATUS_PENDING_APPROVAL = '50';

export type TaskEndOutcome = 'closed' | 'dismissed';

/**
 * Best-effort push of an IClass close action when a task ends in Prominense
 * (closed or dismissed), so the field OS does not stay open forever.
 *
 * NEVER throws: this is a side effect of SetTaskGeneralStatus / UpdateTask, called
 * AFTER their local write already succeeded — a failure here must never look like
 * the local operation failed.
 *
 * Distinct from CloseIClassServiceOrder: that use case is the explicit "Cerrar OS"
 * button (validates the operator's own resultCode, pushes it, closes local). This
 * service reacts to a Prominense-side end that did NOT go through that button —
 * IClass is not yet informed, so it pushes a fixed Prominense-origin result code.
 */
export class PushIClassClosureOnTaskEnd {
  constructor(
    private readonly iclass: IClassPort,
    private readonly flagRepo: FeatureFlagRepository,
  ) {}

  async execute(task: ScheduledTask, outcome: TaskEndOutcome, actorName: string): Promise<void> {
    try {
      const flag = await this.flagRepo.get('iclass-close-action');
      if (!flag?.enabled) return;
      if (!task.iclassOrderCode) return;

      const snapshot = await this.iclass.getServiceOrder(task.iclassOrderCode);
      if (!snapshot) {
        // IClass only lists SOs updated in the last 29 days — an older one stays open there.
        // eslint-disable-next-line no-console
        console.warn(`[iclass-close-push] task ${task.id}: OS ${task.iclassOrderCode} not found in the IClass lookup window; left open in IClass`);
        return;
      }
      if (snapshot.statusCode === ICLASS_STATUS_CLOSED || snapshot.statusCode === ICLASS_STATUS_PENDING_APPROVAL) return;

      await this.iclass.closeServiceOrder({
        serviceOrderCode: task.iclassOrderCode,
        resultCode: outcome === 'closed' ? ICLASS_COMPLETED_IN_PROMINENSE : ICLASS_CANCELLED_IN_PROMINENSE,
        closeDate: new Date(),
        commentary:
          outcome === 'closed'
            ? `Tarea cerrada en Prominense por ${actorName}`
            : `Tarea descartada en Prominense por ${actorName}`,
        visibleToCustomer: false,
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`[iclass-close-push] task ${task.id}: failed to push the IClass closure on task end:`, error);
    }
  }
}
