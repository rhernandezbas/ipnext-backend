/**
 * STRICT TDD — AssignIClassTeam use case.
 * Tests for the schedule window requirement added in issue #130.
 */
import { AssignIClassTeam } from '@application/use-cases/AssignIClassTeam';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryStageRepository } from '@infrastructure/adapters/in-memory/InMemoryStageRepository';
import { InMemoryIClassClient } from '@infrastructure/adapters/in-memory/InMemoryIClassClient';
import { InMemoryIClassTeamRepository } from '@infrastructure/adapters/in-memory/InMemoryIClassTeamRepository';
import { InMemoryFeatureFlagRepository } from '@infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { MissingRequiredFieldsError } from '@domain/errors/scheduling';
import { IClassNoServiceOrderError } from '@domain/errors/iclass';

const TASK_ID = 'task-assign-1';
const ORDER_CODE = 'OS-ASSIGN-1';
const TEAM_LOGIN = 'equipe-assign';

async function makeRepos() {
  const stageRepo = new InMemoryStageRepository();
  const schedulingRepo = new InMemorySchedulingRepository(stageRepo);
  const iclass = new InMemoryIClassClient();
  const teamRepo = new InMemoryIClassTeamRepository();
  const flagRepo = new InMemoryFeatureFlagRepository();

  // Flag ON
  flagRepo.seed('iclass-assign-action', true);

  // Active + selectable team
  await teamRepo.upsertByLogin({
    login: TEAM_LOGIN,
    name: 'Equipe Assign',
    thirdPartyCode: null,
    active: true,
    selectable: true,
  });

  // Task with iclassOrderCode, open, and schedule window
  schedulingRepo.seedTask({
    id: TASK_ID,
    iclassOrderCode: ORDER_CODE,
    generalStatus: 'open',
    title: 'Task Assign',
    startDate: '2026-06-18T11:00:00.000Z',
    endDate: '2026-06-18T15:00:00.000Z',
  });

  // Non-terminal OS snapshot
  iclass.setServiceOrderSnapshot(ORDER_CODE, {
    iclassId: 'iclass-assign-1',
    iclassCodigo: ORDER_CODE,
    statusCode: '1',
    statusDescription: 'Aberta',
  });

  return { schedulingRepo, iclass, teamRepo, flagRepo };
}

describe('AssignIClassTeam', () => {
  // Happy path: schedule present → updateServiceOrder called with window
  it('happy path: passes scheduleStart + scheduleEnd to updateServiceOrder', async () => {
    const { schedulingRepo, iclass, teamRepo, flagRepo } = await makeRepos();
    const uc = new AssignIClassTeam(schedulingRepo, iclass, teamRepo, flagRepo);

    await uc.execute({ taskId: TASK_ID, teamLogin: TEAM_LOGIN, actorId: null });

    const calls = iclass.getUpdateServiceOrderCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.serviceOrderCode).toBe(ORDER_CODE);
    expect(calls[0]!.requiredTeam).toBe(TEAM_LOGIN);
    expect(calls[0]!.scheduleStart).toBeInstanceOf(Date);
    expect(calls[0]!.scheduleEnd).toBeInstanceOf(Date);
    expect(calls[0]!.scheduleStart.toISOString()).toBe('2026-06-18T11:00:00.000Z');
    expect(calls[0]!.scheduleEnd.toISOString()).toBe('2026-06-18T15:00:00.000Z');
  });

  // Missing startDate → MissingRequiredFieldsError
  it('task with no startDate → throws MissingRequiredFieldsError', async () => {
    const { schedulingRepo, iclass, teamRepo, flagRepo } = await makeRepos();
    schedulingRepo.seedTask({
      id: 'task-no-start',
      iclassOrderCode: ORDER_CODE,
      generalStatus: 'open',
      title: 'No Start',
      startDate: null,
      endDate: '2026-06-18T15:00:00.000Z',
    });

    const uc = new AssignIClassTeam(schedulingRepo, iclass, teamRepo, flagRepo);
    const err = await uc
      .execute({ taskId: 'task-no-start', teamLogin: TEAM_LOGIN, actorId: null })
      .catch(e => e);

    expect(err).toBeInstanceOf(MissingRequiredFieldsError);
    expect((err as MissingRequiredFieldsError).missingFields).toContain('startDate');
    expect((err as MissingRequiredFieldsError).missingFields).toContain('endDate');
    // updateServiceOrder must NOT have been called
    expect(iclass.getUpdateServiceOrderCalls()).toHaveLength(0);
  });

  // Missing endDate → MissingRequiredFieldsError
  it('task with no endDate → throws MissingRequiredFieldsError', async () => {
    const { schedulingRepo, iclass, teamRepo, flagRepo } = await makeRepos();
    schedulingRepo.seedTask({
      id: 'task-no-end',
      iclassOrderCode: ORDER_CODE,
      generalStatus: 'open',
      title: 'No End',
      startDate: '2026-06-18T11:00:00.000Z',
      endDate: null,
    });

    const uc = new AssignIClassTeam(schedulingRepo, iclass, teamRepo, flagRepo);
    const err = await uc
      .execute({ taskId: 'task-no-end', teamLogin: TEAM_LOGIN, actorId: null })
      .catch(e => e);

    expect(err).toBeInstanceOf(MissingRequiredFieldsError);
    expect(iclass.getUpdateServiceOrderCalls()).toHaveLength(0);
  });

  // Both null → MissingRequiredFieldsError
  it('task with startDate=null AND endDate=null → throws MissingRequiredFieldsError', async () => {
    const { schedulingRepo, iclass, teamRepo, flagRepo } = await makeRepos();
    schedulingRepo.seedTask({
      id: 'task-no-sched',
      iclassOrderCode: ORDER_CODE,
      generalStatus: 'open',
      title: 'No Schedule',
      startDate: null,
      endDate: null,
    });

    const uc = new AssignIClassTeam(schedulingRepo, iclass, teamRepo, flagRepo);
    const err = await uc
      .execute({ taskId: 'task-no-sched', teamLogin: TEAM_LOGIN, actorId: null })
      .catch(e => e);

    expect(err).toBeInstanceOf(MissingRequiredFieldsError);
    expect(iclass.getUpdateServiceOrderCalls()).toHaveLength(0);
  });

  // No iclassOrderCode → IClassNoServiceOrderError (regression guard)
  it('task with no iclassOrderCode → throws IClassNoServiceOrderError', async () => {
    const { schedulingRepo, iclass, teamRepo, flagRepo } = await makeRepos();
    schedulingRepo.seedTask({
      id: 'task-no-os',
      iclassOrderCode: null,
      generalStatus: 'open',
      title: 'No OS',
      startDate: '2026-06-18T11:00:00.000Z',
      endDate: '2026-06-18T15:00:00.000Z',
    });

    const uc = new AssignIClassTeam(schedulingRepo, iclass, teamRepo, flagRepo);
    await expect(
      uc.execute({ taskId: 'task-no-os', teamLogin: TEAM_LOGIN, actorId: null }),
    ).rejects.toBeInstanceOf(IClassNoServiceOrderError);
  });
});
