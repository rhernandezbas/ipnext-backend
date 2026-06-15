/**
 * STRICT TDD — tests cover scenarios A1-A5 from the design matrix.
 * Tests written BEFORE the implementation.
 */
import { SetTechnicianTeamMapping } from '@application/use-cases/SetTechnicianTeamMapping';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryIClassTeamRepository } from '@infrastructure/adapters/in-memory/InMemoryIClassTeamRepository';
import { IClassTeamNotAssignableError } from '@domain/errors/iclass';
import { ReferenceNotFoundError } from '@domain/errors/scheduling';

const TEAM_ACTIVE_SELECTABLE = {
  login: 'equipe-01',
  name: 'Equipe 01',
  thirdPartyCode: null,
  active: true,
  selectable: true,
};

async function makeRepos() {
  const teamRepo = new InMemoryIClassTeamRepository();
  const userRepo = new InMemoryRbacUserRepository(undefined, undefined, teamRepo);

  // Seed a valid team
  await teamRepo.upsertByLogin(TEAM_ACTIVE_SELECTABLE);

  // Seed an inactive team
  await teamRepo.upsertByLogin({ login: 'equipe-inactiva', name: 'Inactiva', thirdPartyCode: null, active: false, selectable: true });

  // Seed a grouper team (selectable=false)
  await teamRepo.upsertByLogin({ login: 'equipe-grouper', name: 'Grouper', thirdPartyCode: null, active: true, selectable: false });

  // Seed a technician user
  const user = await userRepo.create({
    name: 'Técnico Uno',
    email: 'tecnico1@test.com',
    login: 'tecnico1',
    passwordHash: 'hash',
  });

  return { teamRepo, userRepo, userId: user.id };
}

describe('SetTechnicianTeamMapping', () => {
  // A1: mapping valid team → persists iclassTeamLogin
  it('A1: maps técnico to active+selectable team → persists iclassTeamLogin', async () => {
    const { teamRepo, userRepo, userId } = await makeRepos();
    const uc = new SetTechnicianTeamMapping(userRepo, teamRepo);

    const result = await uc.execute({ userId, iclassTeamLogin: 'equipe-01' });

    expect(result.iclassTeamLogin).toBe('equipe-01');
    // Verify persistence
    const fetched = await userRepo.findById(userId);
    expect(fetched!.iclassTeamLogin).toBe('equipe-01');
  });

  // A2: mapping to inactive team → IClassTeamNotAssignableError
  it('A2: maps to inactive team → throws IClassTeamNotAssignableError', async () => {
    const { teamRepo, userRepo, userId } = await makeRepos();
    const uc = new SetTechnicianTeamMapping(userRepo, teamRepo);

    await expect(uc.execute({ userId, iclassTeamLogin: 'equipe-inactiva' }))
      .rejects.toBeInstanceOf(IClassTeamNotAssignableError);

    // Must not have persisted
    const fetched = await userRepo.findById(userId);
    expect(fetched!.iclassTeamLogin).toBeNull();
  });

  // A3: mapping to non-selectable (grouper) → IClassTeamNotAssignableError
  it('A3: maps to grouper team (selectable=false) → throws IClassTeamNotAssignableError', async () => {
    const { teamRepo, userRepo, userId } = await makeRepos();
    const uc = new SetTechnicianTeamMapping(userRepo, teamRepo);

    await expect(uc.execute({ userId, iclassTeamLogin: 'equipe-grouper' }))
      .rejects.toBeInstanceOf(IClassTeamNotAssignableError);
  });

  // A4: mapping with null → desmaps always OK
  it('A4: maps with null (desmapear) → persists null without validation', async () => {
    const { teamRepo, userRepo, userId } = await makeRepos();
    // First map to something
    await userRepo.update(userId, { iclassTeamLogin: 'equipe-01' });

    const uc = new SetTechnicianTeamMapping(userRepo, teamRepo);
    const result = await uc.execute({ userId, iclassTeamLogin: null });

    expect(result.iclassTeamLogin).toBeNull();
    const fetched = await userRepo.findById(userId);
    expect(fetched!.iclassTeamLogin).toBeNull();
  });

  // A5: non-existent userId → ReferenceNotFoundError (404)
  it('A5: non-existent userId → throws ReferenceNotFoundError', async () => {
    const { teamRepo, userRepo } = await makeRepos();
    const uc = new SetTechnicianTeamMapping(userRepo, teamRepo);

    await expect(uc.execute({ userId: 'non-existent-id', iclassTeamLogin: 'equipe-01' }))
      .rejects.toBeInstanceOf(ReferenceNotFoundError);
  });

  // Non-existent team login → IClassTeamNotAssignableError
  it('maps to non-existent team login → throws IClassTeamNotAssignableError', async () => {
    const { teamRepo, userRepo, userId } = await makeRepos();
    const uc = new SetTechnicianTeamMapping(userRepo, teamRepo);

    await expect(uc.execute({ userId, iclassTeamLogin: 'equipe-fantasma' }))
      .rejects.toBeInstanceOf(IClassTeamNotAssignableError);
  });
});
