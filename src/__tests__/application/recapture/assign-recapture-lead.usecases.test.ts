/**
 * AssignRecaptureLead use-case — strict TDD via InMemoryRecaptureRepository.
 * No Prisma mocking. Mirrors the pattern in recapture.usecases.test.ts.
 */
import { InMemoryRecaptureRepository } from '../../../infrastructure/adapters/in-memory/InMemoryRecaptureRepository';
import { RecaptureLeadNotFoundError } from '../../../domain/errors/recapture';
import { ReferenceNotFoundError } from '../../../domain/errors/scheduling';
import { AssignRecaptureLead } from '../../../application/use-cases/recapture/AssignRecaptureLead';
import type { EntityLookup } from '../../../domain/ports/EntityLookup';
import type { RecaptureLead } from '../../../domain/entities/recaptureLead';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRepo(): InMemoryRecaptureRepository {
  const repo = new InMemoryRecaptureRepository();
  repo.reset();
  return repo;
}

async function seedFreeLead(repo: InMemoryRecaptureRepository): Promise<RecaptureLead> {
  return repo.create({
    source: 'churned_client',
    clientId: 'client-1',
    contactName: 'Juan Pérez',
    phone: '1234567890',
    email: 'juan@example.com',
  });
}

function makeUserLookup(knownIds: string[]): EntityLookup {
  return {
    findById: async (id: string) =>
      knownIds.includes(id) ? { id, name: `User ${id}` } : null,
  };
}

// ─── AssignRecaptureLead ──────────────────────────────────────────────────────

describe('AssignRecaptureLead', () => {
  it('assigns a lead to a valid operator — sets assigneeId + status en_gestion + claimedAt', async () => {
    const repo = makeRepo();
    const lead = await seedFreeLead(repo);
    const userLookup = makeUserLookup(['user-A']);
    const uc = new AssignRecaptureLead(repo, userLookup);

    const dto = await uc.execute(lead.id, 'user-A');

    expect(dto.assigneeId).toBe('user-A');
    expect(dto.status).toBe('en_gestion');
    expect(dto.claimedAt).not.toBeNull();
  });

  it('reassigns a lead already claimed by another operator', async () => {
    const repo = makeRepo();
    const lead = await seedFreeLead(repo);
    await repo.claim(lead.id, 'user-A');
    const userLookup = makeUserLookup(['user-A', 'user-B']);
    const uc = new AssignRecaptureLead(repo, userLookup);

    const dto = await uc.execute(lead.id, 'user-B');

    expect(dto.assigneeId).toBe('user-B');
    expect(dto.status).toBe('en_gestion');
  });

  it('unassigns a lead when operatorId is null — resets to status nuevo', async () => {
    const repo = makeRepo();
    const lead = await seedFreeLead(repo);
    await repo.claim(lead.id, 'user-A');
    const userLookup = makeUserLookup(['user-A']);
    const uc = new AssignRecaptureLead(repo, userLookup);

    const dto = await uc.execute(lead.id, null);

    expect(dto.assigneeId).toBeNull();
    expect(dto.claimedAt).toBeNull();
    expect(dto.status).toBe('nuevo');
  });

  it('throws ReferenceNotFoundError when operatorId is not a real user', async () => {
    const repo = makeRepo();
    const lead = await seedFreeLead(repo);
    const userLookup = makeUserLookup([]); // nobody exists
    const uc = new AssignRecaptureLead(repo, userLookup);

    await expect(uc.execute(lead.id, 'ghost-user')).rejects.toThrow(ReferenceNotFoundError);
  });

  it('throws RecaptureLeadNotFoundError when lead does not exist', async () => {
    const repo = makeRepo();
    const userLookup = makeUserLookup(['user-A']);
    const uc = new AssignRecaptureLead(repo, userLookup);

    await expect(uc.execute('nonexistent-lead', 'user-A')).rejects.toThrow(RecaptureLeadNotFoundError);
  });

  it('skips user lookup when operatorId is null (no unnecessary validation)', async () => {
    const repo = makeRepo();
    const lead = await seedFreeLead(repo);
    const userLookup: EntityLookup = {
      findById: jest.fn().mockResolvedValue(null),
    };
    const uc = new AssignRecaptureLead(repo, userLookup);

    // Should not call findById at all when unassigning
    const dto = await uc.execute(lead.id, null);
    expect(dto.assigneeId).toBeNull();
    expect(userLookup.findById).not.toHaveBeenCalled();
  });
});
