/**
 * STRICT TDD — scenarios B1-B10 from the design matrix.
 * Tests written BEFORE the implementation.
 */
import { AutoAssignIClassTeamOnTaskUpdate } from '@application/use-cases/AutoAssignIClassTeamOnTaskUpdate';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryStageRepository } from '@infrastructure/adapters/in-memory/InMemoryStageRepository';
import { InMemoryIClassClient } from '@infrastructure/adapters/in-memory/InMemoryIClassClient';
import { InMemoryIClassTeamRepository } from '@infrastructure/adapters/in-memory/InMemoryIClassTeamRepository';
import { InMemoryFeatureFlagRepository } from '@infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';

const TASK_ID = 'task-autoassign';
const ORDER_CODE = 'OS-AUTO-1';
const TEAM_LOGIN = 'equipe-auto';
const ACTOR = { actorId: 'op-1', actorName: 'Operator' };

async function makeRepos() {
  const stageRepo = new InMemoryStageRepository();
  const schedulingRepo = new InMemorySchedulingRepository(stageRepo);
  const iclass = new InMemoryIClassClient();
  const teamRepo = new InMemoryIClassTeamRepository();
  const flagRepo = new InMemoryFeatureFlagRepository();
  const userRepo = new InMemoryRbacUserRepository(undefined, undefined, teamRepo);

  // Seed flag ON
  flagRepo.seed('iclass-assign-action', true);

  // Seed active+selectable team
  await teamRepo.upsertByLogin({ login: TEAM_LOGIN, name: 'Equipe Auto', thirdPartyCode: null, active: true, selectable: true });

  // Seed technician with team mapped
  const tech = await userRepo.create({ name: 'Tech One', email: 'tech1@test.com', login: 'tech1', passwordHash: 'h' });
  await userRepo.update(tech.id, { iclassTeamLogin: TEAM_LOGIN });

  // Seed task with iclassOrderCode and open
  schedulingRepo.seedTask({ id: TASK_ID, iclassOrderCode: ORDER_CODE, generalStatus: 'open', title: 'Task Auto' });

  // Seed OS snapshot (non-terminal)
  iclass.setServiceOrderSnapshot(ORDER_CODE, { iclassId: 'iclass-auto-1', iclassCodigo: ORDER_CODE, statusCode: '1', statusDescription: 'Aberta' });

  return { schedulingRepo, iclass, teamRepo, flagRepo, userRepo, techId: tech.id };
}

describe('AutoAssignIClassTeamOnTaskUpdate', () => {
  // B1: happy path → updateServiceOrder called + activity recorded + outcome assigned
  it('B1: happy path → outcome assigned + updateServiceOrder called + activity recorded', async () => {
    const { schedulingRepo, iclass, teamRepo, flagRepo, userRepo, techId } = await makeRepos();

    const activityLog: { type: string }[] = [];
    const recorder = {
      record: async (_id: string, type: string) => { activityLog.push({ type }); },
      recordMany: async () => {},
    };

    const uc = new AutoAssignIClassTeamOnTaskUpdate(schedulingRepo, iclass, teamRepo, flagRepo, userRepo, recorder);
    const result = await uc.maybeAssign(TASK_ID, techId, ACTOR);

    expect(result.outcome).toBe('assigned');
    expect(result.teamLogin).toBe(TEAM_LOGIN);
    const updateCalls = iclass.getUpdateServiceOrderCalls();
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.requiredTeam).toBe(TEAM_LOGIN);
    expect(updateCalls[0]!.serviceOrderCode).toBe(ORDER_CODE);
    expect(activityLog).toHaveLength(1);
    expect(activityLog[0]!.type).toBe('iclass_team_auto_assigned');
  });

  // B2: flag OFF → skipped: flag-off, IClass NOT called
  it('B2: flag OFF → skipped: flag-off, IClass NOT called', async () => {
    const { schedulingRepo, iclass, teamRepo, flagRepo, userRepo, techId } = await makeRepos();
    flagRepo.seed('iclass-assign-action', false);

    const uc = new AutoAssignIClassTeamOnTaskUpdate(schedulingRepo, iclass, teamRepo, flagRepo, userRepo);
    const result = await uc.maybeAssign(TASK_ID, techId, ACTOR);

    expect(result.outcome).toBe('skipped');
    expect(result.reason).toBe('flag-off');
    expect(iclass.getUpdateServiceOrderCalls()).toHaveLength(0);
  });

  // B3: task has no iclassOrderCode → skipped: no-order-code
  it('B3: task without iclassOrderCode → skipped: no-order-code', async () => {
    const { schedulingRepo, iclass, teamRepo, flagRepo, userRepo, techId } = await makeRepos();
    schedulingRepo.seedTask({ id: 'task-no-os', iclassOrderCode: null, generalStatus: 'open', title: 'No OS' });

    const uc = new AutoAssignIClassTeamOnTaskUpdate(schedulingRepo, iclass, teamRepo, flagRepo, userRepo);
    const result = await uc.maybeAssign('task-no-os', techId, ACTOR);

    expect(result.outcome).toBe('skipped');
    expect(result.reason).toBe('no-order-code');
  });

  // B4: technician has no iclassTeamLogin → skipped: no-mapping
  it('B4: technician without iclassTeamLogin → skipped: no-mapping', async () => {
    const { schedulingRepo, iclass, teamRepo, flagRepo, userRepo } = await makeRepos();
    const unmapped = await userRepo.create({ name: 'No team', email: 'nomapping@test.com', login: 'nomapping', passwordHash: 'h' });

    const uc = new AutoAssignIClassTeamOnTaskUpdate(schedulingRepo, iclass, teamRepo, flagRepo, userRepo);
    const result = await uc.maybeAssign(TASK_ID, unmapped.id, ACTOR);

    expect(result.outcome).toBe('skipped');
    expect(result.reason).toBe('no-mapping');
  });

  // B5: assigneeId null → skipped: no-mapping (desasignar)
  it('B5: assigneeId null → skipped: no-mapping', async () => {
    const { schedulingRepo, iclass, teamRepo, flagRepo, userRepo } = await makeRepos();

    const uc = new AutoAssignIClassTeamOnTaskUpdate(schedulingRepo, iclass, teamRepo, flagRepo, userRepo);
    const result = await uc.maybeAssign(TASK_ID, null, ACTOR);

    expect(result.outcome).toBe('skipped');
    expect(result.reason).toBe('no-mapping');
  });

  // B6: cuadrilla mapeada quedó inactiva → skipped: team-inactive
  it('B6: mapped team became inactive → skipped: team-inactive, IClass NOT called', async () => {
    const { schedulingRepo, iclass, teamRepo, flagRepo, userRepo, techId } = await makeRepos();
    // Deactivate the team (simulate sync making it inactive)
    await teamRepo.upsertByLogin({ login: TEAM_LOGIN, name: 'Equipe Auto', thirdPartyCode: null, active: false, selectable: true });

    const uc = new AutoAssignIClassTeamOnTaskUpdate(schedulingRepo, iclass, teamRepo, flagRepo, userRepo);
    const result = await uc.maybeAssign(TASK_ID, techId, ACTOR);

    expect(result.outcome).toBe('skipped');
    expect(result.reason).toBe('team-inactive');
    expect(iclass.getUpdateServiceOrderCalls()).toHaveLength(0);
  });

  // B7: task not open → skipped: not-open
  it('B7: task generalStatus !== open → skipped: not-open', async () => {
    const { schedulingRepo, iclass, teamRepo, flagRepo, userRepo, techId } = await makeRepos();
    schedulingRepo.seedTask({ id: 'task-closed', iclassOrderCode: ORDER_CODE, generalStatus: 'closed', title: 'Closed' });

    const uc = new AutoAssignIClassTeamOnTaskUpdate(schedulingRepo, iclass, teamRepo, flagRepo, userRepo);
    const result = await uc.maybeAssign('task-closed', techId, ACTOR);

    expect(result.outcome).toBe('skipped');
    expect(result.reason).toBe('not-open');
  });

  // B8: OS terminal in IClass (statusCode '7') → skipped: order-closed
  it('B8: OS terminal in IClass → skipped: order-closed, updateServiceOrder NOT called', async () => {
    const { schedulingRepo, iclass, teamRepo, flagRepo, userRepo, techId } = await makeRepos();
    iclass.setServiceOrderSnapshot(ORDER_CODE, { iclassId: 'iclass-auto-1', iclassCodigo: ORDER_CODE, statusCode: '7', statusDescription: 'Fechada' });

    const uc = new AutoAssignIClassTeamOnTaskUpdate(schedulingRepo, iclass, teamRepo, flagRepo, userRepo);
    const result = await uc.maybeAssign(TASK_ID, techId, ACTOR);

    expect(result.outcome).toBe('skipped');
    expect(result.reason).toBe('order-closed');
    expect(iclass.getUpdateServiceOrderCalls()).toHaveLength(0);
  });

  // B9: IClass rejects → failed: rejected + activity recorded + NEVER propagates
  it('B9: IClass rejects → failed: rejected, activity recorded, no throw', async () => {
    const { schedulingRepo, iclass, teamRepo, flagRepo, userRepo, techId } = await makeRepos();
    iclass.setUpdateMode('rejected');

    const activityLog: { type: string }[] = [];
    const recorder = {
      record: async (_id: string, type: string) => { activityLog.push({ type }); },
      recordMany: async () => {},
    };

    const uc = new AutoAssignIClassTeamOnTaskUpdate(schedulingRepo, iclass, teamRepo, flagRepo, userRepo, recorder);
    const result = await uc.maybeAssign(TASK_ID, techId, ACTOR);

    expect(result.outcome).toBe('failed');
    expect(result.reason).toBe('rejected');
    expect(activityLog.some(a => a.type === 'iclass_team_auto_assign_failed')).toBe(true);
    // No throw
  });

  // B10: IClass unavailable → failed: unavailable + NEVER propagates
  it('B10: IClass unavailable → failed: unavailable, no throw', async () => {
    const { schedulingRepo, iclass, teamRepo, flagRepo, userRepo, techId } = await makeRepos();
    iclass.setUpdateMode('unavailable');

    const uc = new AutoAssignIClassTeamOnTaskUpdate(schedulingRepo, iclass, teamRepo, flagRepo, userRepo);
    const result = await uc.maybeAssign(TASK_ID, techId, ACTOR);

    expect(result.outcome).toBe('failed');
    expect(result.reason).toBe('unavailable');
    // No throw
  });

  // Extra: maybeAssign NEVER throws even on unexpected errors
  it('NEVER throws: internal crash → returns failed outcome', async () => {
    const { schedulingRepo, teamRepo, flagRepo, userRepo, techId } = await makeRepos();
    // Inject a broken IClass that throws unexpectedly
    const brokenIClass = {
      getServiceOrder: async () => { throw new Error('Unexpected crash'); },
      updateServiceOrder: async () => { throw new Error('Should not reach'); },
    } as any;

    const uc = new AutoAssignIClassTeamOnTaskUpdate(schedulingRepo, brokenIClass, teamRepo, flagRepo, userRepo);

    // This MUST NOT throw — it's best-effort
    const result = await uc.maybeAssign(TASK_ID, techId, ACTOR);
    expect(result.outcome).toBe('failed');
  });
});
