import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { IClassPort } from '@domain/ports/IClassPort';
import { IClassTeamRepository } from '@domain/ports/IClassTeamRepository';
import { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import { TaskActivityRecorder, ActorContext } from '@domain/ports/TaskActivityRecorder';
import { ScheduledTask } from '@domain/entities/scheduling';
import { TaskNotFoundError, MissingRequiredFieldsError } from '@domain/errors/scheduling';
import {
  IClassActionDisabledError,
  IClassTaskNotOpenError,
  IClassAlreadyClosedError,
  IClassNoServiceOrderError,
  IClassTeamNotAssignableError,
} from '@domain/errors/iclass';

export interface AssignIClassTeamInput {
  taskId: string;
  teamLogin: string;
  actorId: string | null;
}

/**
 * Assigns an IClass team to a Service Order from Prominense.
 *
 * Flow (per design AD-1, AD-3, Ola B):
 * 1. Check feature flag `iclass-assign-action` — OFF → IClassActionDisabledError (409)
 * 2. Resolve task — not found → TaskNotFoundError (404)
 * 3. Check task.iclassOrderCode — null → IClassNoServiceOrderError (422)
 * 4. Check task.generalStatus === 'open' — no → IClassTaskNotOpenError (409)
 * 5. Resolve team from catalog — not found/inactive/not-selectable → IClassTeamNotAssignableError (422)
 * 6. Live pre-check: getServiceOrder
 *    - null → IClassNoServiceOrderError (422)
 *    - statusCode === '7' → IClassAlreadyClosedError (409)
 * 7. updateServiceOrder — errors propagate
 * 8. Record activity 'iclass_team_assigned'
 * 9. Return task DTO (generalStatus unchanged — assign doesn't close locally)
 */
export class AssignIClassTeam {
  constructor(
    private readonly schedulingRepo: SchedulingRepository,
    private readonly iclass: IClassPort,
    private readonly teamRepo: IClassTeamRepository,
    private readonly flagRepo: FeatureFlagRepository,
    private readonly recorder?: TaskActivityRecorder,
  ) {}

  async execute(input: AssignIClassTeamInput): Promise<ScheduledTask> {
    const { taskId, teamLogin, actorId } = input;

    // Step 1: Feature flag gate
    const flag = await this.flagRepo.get('iclass-assign-action');
    if (!flag?.enabled) {
      throw new IClassActionDisabledError('iclass-assign-action');
    }

    // Step 2: Resolve task
    const task = await this.schedulingRepo.getTask(taskId);
    if (!task) throw new TaskNotFoundError(taskId);

    // Step 3: Task must have an iclassOrderCode
    if (!task.iclassOrderCode) {
      throw new IClassNoServiceOrderError('task has no iclassOrderCode');
    }

    // Step 4: Task must be open
    if (task.generalStatus !== 'open') {
      throw new IClassTaskNotOpenError(taskId);
    }

    // Step 5: Validate team from catalog
    const team = await this.teamRepo.getByLogin(teamLogin);
    if (!team) {
      throw new IClassTeamNotAssignableError(teamLogin, 'team not found in catalog');
    }
    if (!team.active) {
      throw new IClassTeamNotAssignableError(teamLogin, 'team is inactive');
    }
    if (!team.selectable) {
      throw new IClassTeamNotAssignableError(teamLogin, 'team is not selectable (grouping team)');
    }

    // Step 6: Live pre-check
    const snapshot = await this.iclass.getServiceOrder(task.iclassOrderCode);
    if (!snapshot) {
      throw new IClassNoServiceOrderError(`IClass does not recognize order "${task.iclassOrderCode}"`);
    }
    if (snapshot.statusCode === '7') {
      throw new IClassAlreadyClosedError(task.iclassOrderCode);
    }

    // Step 7: Push team assignment to IClass (requires schedule window from task)
    if (!task.startDate || !task.endDate) {
      throw new MissingRequiredFieldsError(['startDate', 'endDate']);
    }
    await this.iclass.updateServiceOrder({
      serviceOrderCode: task.iclassOrderCode,
      requiredTeam: team.login,
      scheduleStart: new Date(task.startDate),
      scheduleEnd: new Date(task.endDate),
    });

    // Step 8: Record activity (assign doesn't change local generalStatus)
    if (this.recorder) {
      const actor: ActorContext = { actorId, actorName: actorId ?? 'System' };
      await this.recorder.record(taskId, 'iclass_team_assigned', {
        actor,
        toValue: teamLogin,
      });
    }

    // Step 9: Return task as-is (no local status change)
    return task;
  }
}
