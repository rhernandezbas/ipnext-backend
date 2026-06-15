/**
 * STRICT TDD — test covers scenario A6 from the design matrix.
 */
import { ListTechnicianTeamMappings } from '@application/use-cases/ListTechnicianTeamMappings';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryIClassTeamRepository } from '@infrastructure/adapters/in-memory/InMemoryIClassTeamRepository';

describe('ListTechnicianTeamMappings', () => {
  it('A6: lists users with teamName + teamActive; inactive team degrades teamActive=false', async () => {
    const teamRepo = new InMemoryIClassTeamRepository();
    const userRepo = new InMemoryRbacUserRepository(undefined, undefined, teamRepo);

    // Seed teams
    await teamRepo.upsertByLogin({ login: 'equipe-01', name: 'Equipe 01', thirdPartyCode: null, active: true, selectable: true });
    await teamRepo.upsertByLogin({ login: 'equipe-02', name: 'Equipe Inactiva', thirdPartyCode: null, active: false, selectable: true });

    // Seed users
    const u1 = await userRepo.create({ name: 'Técnico Uno', email: 'u1@test.com', login: 'u1', passwordHash: 'h' });
    const u2 = await userRepo.create({ name: 'Técnico Dos', email: 'u2@test.com', login: 'u2', passwordHash: 'h' });
    const u3 = await userRepo.create({ name: 'Sin cuadrilla', email: 'u3@test.com', login: 'u3', passwordHash: 'h' });

    // Assign teams
    await userRepo.update(u1.id, { iclassTeamLogin: 'equipe-01' });
    await userRepo.update(u2.id, { iclassTeamLogin: 'equipe-02' }); // inactive
    // u3 has no mapping

    const uc = new ListTechnicianTeamMappings(userRepo);
    const result = await uc.execute();

    expect(result).toHaveLength(3);

    const r1 = result.find(r => r.userId === u1.id)!;
    expect(r1.iclassTeamLogin).toBe('equipe-01');
    expect(r1.teamName).toBe('Equipe 01');
    expect(r1.teamActive).toBe(true);

    const r2 = result.find(r => r.userId === u2.id)!;
    expect(r2.iclassTeamLogin).toBe('equipe-02');
    expect(r2.teamName).toBe('Equipe Inactiva');
    expect(r2.teamActive).toBe(false); // degrada

    const r3 = result.find(r => r.userId === u3.id)!;
    expect(r3.iclassTeamLogin).toBeNull();
    expect(r3.teamName).toBeNull();
    expect(r3.teamActive).toBe(false);
  });
});
