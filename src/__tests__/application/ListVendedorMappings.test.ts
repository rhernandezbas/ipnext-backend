/**
 * STRICT TDD — GR vendedor mapping (Fase 2b).
 * Cloned from ListTechnicianTeamMappings.test.ts.
 */
import { ListVendedorMappings } from '@application/use-cases/ListVendedorMappings';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';

describe('ListVendedorMappings', () => {
  it('lists all users with their grVendedorName (null when unmapped)', async () => {
    const userRepo = new InMemoryRbacUserRepository();

    const u1 = await userRepo.create({ name: 'Vendedor Uno', email: 'u1@test.com', login: 'u1', passwordHash: 'h' });
    const u2 = await userRepo.create({ name: 'Vendedor Dos', email: 'u2@test.com', login: 'u2', passwordHash: 'h' });
    const u3 = await userRepo.create({ name: 'Sin vendedor', email: 'u3@test.com', login: 'u3', passwordHash: 'h' });

    await userRepo.update(u1.id, { grVendedorName: 'JUAN PEREZ' });
    await userRepo.update(u2.id, { grVendedorName: 'MARIA LOPEZ' });
    // u3 has no mapping

    const uc = new ListVendedorMappings(userRepo);
    const result = await uc.execute();

    expect(result).toHaveLength(3);

    const r1 = result.find(r => r.userId === u1.id)!;
    expect(r1.userName).toBe('Vendedor Uno');
    expect(r1.userLogin).toBe('u1');
    expect(r1.grVendedorName).toBe('JUAN PEREZ');

    const r2 = result.find(r => r.userId === u2.id)!;
    expect(r2.grVendedorName).toBe('MARIA LOPEZ');

    const r3 = result.find(r => r.userId === u3.id)!;
    expect(r3.grVendedorName).toBeNull();
  });
});
