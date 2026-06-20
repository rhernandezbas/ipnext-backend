/**
 * STRICT TDD — GR vendedor mapping (Fase 2b).
 * Tests written BEFORE the implementation.
 *
 * Cloned from SetTechnicianTeamMapping.test.ts. GR vendedor is a free-text
 * soft mapping (no catalog validation like IClass teams) — set/clear/not-found.
 */
import { SetVendedorMapping } from '@application/use-cases/SetVendedorMapping';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { ReferenceNotFoundError } from '@domain/errors/scheduling';

async function makeRepos() {
  const userRepo = new InMemoryRbacUserRepository();
  const user = await userRepo.create({
    name: 'Vendedor Uno',
    email: 'vendedor1@test.com',
    login: 'vendedor1',
    passwordHash: 'hash',
  });
  return { userRepo, userId: user.id };
}

describe('SetVendedorMapping', () => {
  it('maps user to a GR vendedor name → persists grVendedorName', async () => {
    const { userRepo, userId } = await makeRepos();
    const uc = new SetVendedorMapping(userRepo);

    const result = await uc.execute({ userId, grVendedorName: 'JUAN PEREZ' });

    expect(result.grVendedorName).toBe('JUAN PEREZ');
    const fetched = await userRepo.findById(userId);
    expect(fetched!.grVendedorName).toBe('JUAN PEREZ');
  });

  it('maps with null (desmapear) → persists null', async () => {
    const { userRepo, userId } = await makeRepos();
    // First map to something
    await userRepo.update(userId, { grVendedorName: 'JUAN PEREZ' });

    const uc = new SetVendedorMapping(userRepo);
    const result = await uc.execute({ userId, grVendedorName: null });

    expect(result.grVendedorName).toBeNull();
    const fetched = await userRepo.findById(userId);
    expect(fetched!.grVendedorName).toBeNull();
  });

  it('non-existent userId → throws ReferenceNotFoundError', async () => {
    const { userRepo } = await makeRepos();
    const uc = new SetVendedorMapping(userRepo);

    await expect(uc.execute({ userId: 'non-existent-id', grVendedorName: 'JUAN PEREZ' }))
      .rejects.toBeInstanceOf(ReferenceNotFoundError);
  });
});
