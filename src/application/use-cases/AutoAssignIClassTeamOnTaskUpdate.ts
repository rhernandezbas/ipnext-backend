import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { IClassPort } from '@domain/ports/IClassPort';
import { IClassTeamRepository } from '@domain/ports/IClassTeamRepository';
import { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import { TaskActivityRecorder, ActorContext } from '@domain/ports/TaskActivityRecorder';
import {
  IClassAutoAssigner,
  AutoAssignOutcome,
} from '@domain/ports/IClassAutoAssigner';
import { IClassRejectedError, IClassUnavailableError } from '@domain/errors/iclass';

/**
 * AutoAssignIClassTeamOnTaskUpdate — best-effort IClass team auto-assigner.
 *
 * Implements IClassAutoAssigner (AD-2). maybeAssign NEVER throws — all errors
 * are caught and returned as AutoAssignOutcome { outcome: 'failed' }.
 *
 * Flow (design matrix B1-B10):
 * 1. assigneeId == null → skipped: no-mapping
 * 2. flag 'iclass-assign-action' OFF → skipped: flag-off
 * 3. getTask(taskId); not found → skipped: no-order-code (task gone is safe to skip)
 * 4. task.iclassOrderCode absent → skipped: no-order-code
 * 5. task.generalStatus !== 'open' → skipped: not-open
 * 6. rbacUserRepo.findById(assigneeId); no iclassTeamLogin → skipped: no-mapping
 * 7. teamRepo.getByLogin(login); absent / !active / !selectable → skipped: team-inactive
 * 8. getServiceOrder pre-check; null or statusCode==='7' → skipped: order-closed
 * 9. updateServiceOrder → success: assigned + activity; IClassRejectedError → failed: rejected;
 *    IClassUnavailableError → failed: unavailable.
 * 10. Any unexpected error → failed (no throw).
 */
export class AutoAssignIClassTeamOnTaskUpdate implements IClassAutoAssigner {
  constructor(
    private readonly schedulingRepo: SchedulingRepository,
    private readonly iclass: IClassPort,
    private readonly teamRepo: IClassTeamRepository,
    private readonly flagRepo: FeatureFlagRepository,
    private readonly userRepo: RbacUserRepository,
    private readonly recorder?: TaskActivityRecorder,
  ) {}

  async maybeAssign(
    taskId: string,
    assigneeId: string | null,
    actor?: ActorContext,
  ): Promise<AutoAssignOutcome> {
    try {
      return await this._maybeAssign(taskId, assigneeId, actor);
    } catch (err) {
      // Final safety net: catch-all ensures NEVER throws regardless.
      return { outcome: 'failed', reason: 'unavailable' };
    }
  }

  private async _maybeAssign(
    taskId: string,
    assigneeId: string | null,
    actor?: ActorContext,
  ): Promise<AutoAssignOutcome> {
    // Step 1: null assignee → desassign, skip
    if (assigneeId == null) {
      return { outcome: 'skipped', reason: 'no-mapping' };
    }

    // Step 2: feature flag check
    const flag = await this.flagRepo.get('iclass-assign-action');
    if (!flag?.enabled) {
      return { outcome: 'skipped', reason: 'flag-off' };
    }

    // Step 3+4: resolve task and check iclassOrderCode
    const task = await this.schedulingRepo.getTask(taskId);
    if (!task || !task.iclassOrderCode) {
      return { outcome: 'skipped', reason: 'no-order-code' };
    }

    // Step 5: task must be open
    if (task.generalStatus !== 'open') {
      return { outcome: 'skipped', reason: 'not-open' };
    }

    // Step 6: resolve technician's team login
    const user = await this.userRepo.findById(assigneeId);
    const teamLogin = user?.iclassTeamLogin ?? null;
    if (!teamLogin) {
      return { outcome: 'skipped', reason: 'no-mapping' };
    }

    // Step 7: validate team active && selectable
    const team = await this.teamRepo.getByLogin(teamLogin);
    if (!team || !team.active || !team.selectable) {
      return { outcome: 'skipped', reason: 'team-inactive' };
    }

    // Step 8: live pre-check via getServiceOrder
    const snapshot = await this.iclass.getServiceOrder(task.iclassOrderCode);
    if (!snapshot || snapshot.statusCode === '7') {
      return { outcome: 'skipped', reason: 'order-closed' };
    }

    // Step 8b: task must have a schedule window (required for the update payload)
    if (!task.startDate || !task.endDate) {
      return { outcome: 'skipped', reason: 'no-schedule' };
    }

    // Step 9: push team assignment to IClass
    try {
      await this.iclass.updateServiceOrder({
        serviceOrderCode: task.iclassOrderCode,
        requiredTeam: teamLogin,
        scheduleStart: new Date(task.startDate),
        scheduleEnd: new Date(task.endDate),
      });

      if (this.recorder) {
        await this.recorder.record(taskId, 'iclass_team_auto_assigned', {
          actor: actor ?? { actorId: null, actorName: 'System' },
          toValue: teamLogin,
        });
      }

      return { outcome: 'assigned', teamLogin };
    } catch (err) {
      // Record failure (best-effort — don't throw even if recorder fails)
      try {
        if (this.recorder) {
          const reason = err instanceof IClassRejectedError ? 'rejected'
            : err instanceof IClassUnavailableError ? 'unavailable'
            : 'unavailable';
          await this.recorder.record(taskId, 'iclass_team_auto_assign_failed', {
            actor: actor ?? { actorId: null, actorName: 'System' },
            toValue: reason,
          });
        }
      } catch {
        // ignore recorder error
      }

      if (err instanceof IClassRejectedError) {
        return { outcome: 'failed', reason: 'rejected', teamLogin };
      }
      if (err instanceof IClassUnavailableError) {
        return { outcome: 'failed', reason: 'unavailable', teamLogin };
      }
      // Unexpected error — treat as unavailable
      return { outcome: 'failed', reason: 'unavailable', teamLogin };
    }
  }
}
