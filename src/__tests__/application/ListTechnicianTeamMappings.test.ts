/**
 * STRICT TDD — test covers scenario A6 from the design matrix.
 * #129: listWithIClassTeam must only return users with rol 'tecnico'.
 */
import { ListTechnicianTeamMappings } from '@application/use-cases/ListTechnicianTeamMappings';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryIClassTeamRepository } from '@infrastructure/adapters/in-memory/InMemoryIClassTeamRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';

describe('ListTechnicianTeamMappings', () => {
  it('A6: lists ONLY tecnico users with teamName + teamActive; inactive team degrades teamActive=false', async () => {
    const roleRepo = new InMemoryRbacRoleRepository();
    const userRoleRepo = new InMemoryRbacUserRoleRepository(roleRepo);
    const teamRepo = new InMemoryIClassTeamRepository();
    const userRepo = new InMemoryRbacUserRepository(userRoleRepo, roleRepo, teamRepo);

    // Seed roles
    const tecnicoRole = await roleRepo.create({ code: 'tecnico', label: 'Técnico', isSystem: true });

    // Seed teams
    await teamRepo.upsertByLogin({ login: 'equipe-01', name: 'Equipe 01', thirdPartyCode: null, active: true, selectable: true });
    await teamRepo.upsertByLogin({ login: 'equipe-02', name: 'Equipe Inactiva', thirdPartyCode: null, active: false, selectable: true });

    // Seed users
    const u1 = await userRepo.create({ name: 'Técnico Uno', email: 'u1@test.com', login: 'u1', passwordHash: 'h' });
    const u2 = await userRepo.create({ name: 'Técnico Dos', email: 'u2@test.com', login: 'u2', passwordHash: 'h' });
    const u3 = await userRepo.create({ name: 'Sin cuadrilla', email: 'u3@test.com', login: 'u3', passwordHash: 'h' });

    // Assign tecnico role to u1 and u2; u3 has no role
    await userRoleRepo.assign(u1.id, tecnicoRole.id);
    await userRoleRepo.assign(u2.id, tecnicoRole.id);

    // Assign teams
    await userRepo.update(u1.id, { iclassTeamLogin: 'equipe-01' });
    await userRepo.update(u2.id, { iclassTeamLogin: 'equipe-02' }); // inactive

    const uc = new ListTechnicianTeamMappings(userRepo);
    const result = await uc.execute();

    // Only u1 and u2 are 'tecnico' — u3 must NOT appear
    expect(result).toHaveLength(2);

    const r1 = result.find(r => r.userId === u1.id)!;
    expect(r1.iclassTeamLogin).toBe('equipe-01');
    expect(r1.teamName).toBe('Equipe 01');
    expect(r1.teamActive).toBe(true);

    const r2 = result.find(r => r.userId === u2.id)!;
    expect(r2.iclassTeamLogin).toBe('equipe-02');
    expect(r2.teamName).toBe('Equipe Inactiva');
    expect(r2.teamActive).toBe(false); // degrada

    // u3 is NOT in the result
    expect(result.find(r => r.userId === u3.id)).toBeUndefined();
  });

  it('#129: admin and ventas users are excluded; only tecnico appears', async () => {
    const roleRepo = new InMemoryRbacRoleRepository();
    const userRoleRepo = new InMemoryRbacUserRoleRepository(roleRepo);
    const teamRepo = new InMemoryIClassTeamRepository();
    const userRepo = new InMemoryRbacUserRepository(userRoleRepo, roleRepo, teamRepo);

    // Seed roles
    const tecnicoRole = await roleRepo.create({ code: 'tecnico', label: 'Técnico', isSystem: true });
    const adminRole = await roleRepo.create({ code: 'administrador', label: 'Administrador', isSystem: true });
    const ventasRole = await roleRepo.create({ code: 'ventas', label: 'Ventas', isSystem: true });

    // Seed users
    const tecnico = await userRepo.create({ name: 'Carlos Técnico', email: 'tec@test.com', login: 'tec', passwordHash: 'h' });
    const admin = await userRepo.create({ name: 'Ana Admin', email: 'admin@test.com', login: 'admin', passwordHash: 'h' });
    const ventas = await userRepo.create({ name: 'Luis Ventas', email: 'ventas@test.com', login: 'ventas', passwordHash: 'h' });

    // Assign roles
    await userRoleRepo.assign(tecnico.id, tecnicoRole.id);
    await userRoleRepo.assign(admin.id, adminRole.id);
    await userRoleRepo.assign(ventas.id, ventasRole.id);

    const uc = new ListTechnicianTeamMappings(userRepo);
    const result = await uc.execute();

    expect(result).toHaveLength(1);
    expect(result[0].userId).toBe(tecnico.id);

    // Confirm admin and ventas are NOT in the result
    expect(result.find(r => r.userId === admin.id)).toBeUndefined();
    expect(result.find(r => r.userId === ventas.id)).toBeUndefined();
  });

  it('#129: tecnico with no team mapping appears with null iclassTeamLogin and teamActive=false', async () => {
    const roleRepo = new InMemoryRbacRoleRepository();
    const userRoleRepo = new InMemoryRbacUserRoleRepository(roleRepo);
    const teamRepo = new InMemoryIClassTeamRepository();
    const userRepo = new InMemoryRbacUserRepository(userRoleRepo, roleRepo, teamRepo);

    const tecnicoRole = await roleRepo.create({ code: 'tecnico', label: 'Técnico', isSystem: true });
    const tec = await userRepo.create({ name: 'Técnico Sin Cuadrilla', email: 'tsc@test.com', login: 'tsc', passwordHash: 'h' });
    await userRoleRepo.assign(tec.id, tecnicoRole.id);
    // No team assigned

    const uc = new ListTechnicianTeamMappings(userRepo);
    const result = await uc.execute();

    expect(result).toHaveLength(1);
    expect(result[0].userId).toBe(tec.id);
    expect(result[0].iclassTeamLogin).toBeNull();
    expect(result[0].teamName).toBeNull();
    expect(result[0].teamActive).toBe(false);
  });
});
