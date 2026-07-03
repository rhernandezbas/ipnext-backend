/**
 * AssignRecaptureLead use-case — strict TDD via InMemoryRecaptureRepository.
 * No Prisma mocking. Mirrors the pattern in recapture.usecases.test.ts.
 *
 * recapture-assignable-roles: the use case now enforces the assignee pool
 * (active user WITH at least one role AND none technical) via a 3rd required
 * arg — a UserRoleLookup stub. Non-assignable targets throw
 * RecaptureAssigneeNotAllowedError.
 */
import { InMemoryRecaptureRepository } from '../../../infrastructure/adapters/in-memory/InMemoryRecaptureRepository';
import { RecaptureLeadNotFoundError, RecaptureAssigneeNotAllowedError } from '../../../domain/errors/recapture';
import { ReferenceNotFoundError } from '../../../domain/errors/scheduling';
import { AssignRecaptureLead } from '../../../application/use-cases/recapture/AssignRecaptureLead';
import type { EntityLookup } from '../../../domain/ports/EntityLookup';
import type { UserRoleLookup } from '../../../domain/ports/UserRoleLookup';
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

/** Role lookup stub: maps userId → role codes. Unknown ids resolve to []. */
function makeRoleLookup(rolesById: Record<string, string[]>): UserRoleLookup {
  return {
    listRoleCodes: async (userId: string) => rolesById[userId] ?? [],
  };
}

/** Default non-technical role lookup — every known user carries 'ventas'. */
function ventasRoleLookup(): UserRoleLookup {
  return { listRoleCodes: async () => ['ventas'] };
}

// ─── AssignRecaptureLead ──────────────────────────────────────────────────────

describe('AssignRecaptureLead', () => {
  it('assigns a lead to a valid operator — sets assigneeId + status en_gestion + claimedAt', async () => {
    const repo = makeRepo();
    const lead = await seedFreeLead(repo);
    const userLookup = makeUserLookup(['user-A']);
    const uc = new AssignRecaptureLead(repo, userLookup, ventasRoleLookup());

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
    const uc = new AssignRecaptureLead(repo, userLookup, ventasRoleLookup());

    const dto = await uc.execute(lead.id, 'user-B');

    expect(dto.assigneeId).toBe('user-B');
    expect(dto.status).toBe('en_gestion');
  });

  it('unassigns a lead when operatorId is null — resets to status nuevo', async () => {
    const repo = makeRepo();
    const lead = await seedFreeLead(repo);
    await repo.claim(lead.id, 'user-A');
    const userLookup = makeUserLookup(['user-A']);
    const uc = new AssignRecaptureLead(repo, userLookup, ventasRoleLookup());

    const dto = await uc.execute(lead.id, null);

    expect(dto.assigneeId).toBeNull();
    expect(dto.claimedAt).toBeNull();
    expect(dto.status).toBe('nuevo');
  });

  it('throws ReferenceNotFoundError when operatorId is not a real user', async () => {
    const repo = makeRepo();
    const lead = await seedFreeLead(repo);
    const userLookup = makeUserLookup([]); // nobody exists
    const uc = new AssignRecaptureLead(repo, userLookup, ventasRoleLookup());

    await expect(uc.execute(lead.id, 'ghost-user')).rejects.toThrow(ReferenceNotFoundError);
  });

  it('throws RecaptureLeadNotFoundError when lead does not exist', async () => {
    const repo = makeRepo();
    const userLookup = makeUserLookup(['user-A']);
    const uc = new AssignRecaptureLead(repo, userLookup, ventasRoleLookup());

    await expect(uc.execute('nonexistent-lead', 'user-A')).rejects.toThrow(RecaptureLeadNotFoundError);
  });

  it('skips user + role lookup when operatorId is null (no unnecessary validation)', async () => {
    const repo = makeRepo();
    const lead = await seedFreeLead(repo);
    const userLookup: EntityLookup = {
      findById: jest.fn().mockResolvedValue(null),
    };
    const roleLookup: UserRoleLookup = {
      listRoleCodes: jest.fn().mockResolvedValue([]),
    };
    const uc = new AssignRecaptureLead(repo, userLookup, roleLookup);

    // Should not call findById NOR listRoleCodes when unassigning
    const dto = await uc.execute(lead.id, null);
    expect(dto.assigneeId).toBeNull();
    expect(userLookup.findById).not.toHaveBeenCalled();
    expect(roleLookup.listRoleCodes).not.toHaveBeenCalled();
  });

  // ─── recapture-assignable-roles: assignee-pool enforcement ──────────────────

  it('throws RecaptureAssigneeNotAllowedError when the target holds a technical role', async () => {
    const repo = makeRepo();
    const lead = await seedFreeLead(repo);
    const userLookup = makeUserLookup(['tech-user']);
    const roleLookup = makeRoleLookup({ 'tech-user': ['tecnico'] });
    const uc = new AssignRecaptureLead(repo, userLookup, roleLookup);

    await expect(uc.execute(lead.id, 'tech-user')).rejects.toThrow(RecaptureAssigneeNotAllowedError);
  });

  it('throws RecaptureAssigneeNotAllowedError when the target has NO roles at all', async () => {
    const repo = makeRepo();
    const lead = await seedFreeLead(repo);
    const userLookup = makeUserLookup(['no-role-user']);
    const roleLookup = makeRoleLookup({ 'no-role-user': [] });
    const uc = new AssignRecaptureLead(repo, userLookup, roleLookup);

    await expect(uc.execute(lead.id, 'no-role-user')).rejects.toThrow(RecaptureAssigneeNotAllowedError);
  });

  it('allows a target with the noc role (only tecnico is excluded)', async () => {
    const repo = makeRepo();
    const lead = await seedFreeLead(repo);
    const userLookup = makeUserLookup(['noc-user']);
    const roleLookup = makeRoleLookup({ 'noc-user': ['noc'] });
    const uc = new AssignRecaptureLead(repo, userLookup, roleLookup);

    const dto = await uc.execute(lead.id, 'noc-user');
    expect(dto.assigneeId).toBe('noc-user');
    expect(dto.status).toBe('en_gestion');
  });

  it('rejects a multi-role target that includes tecnico', async () => {
    const repo = makeRepo();
    const lead = await seedFreeLead(repo);
    const userLookup = makeUserLookup(['mixed-user']);
    const roleLookup = makeRoleLookup({ 'mixed-user': ['ventas', 'tecnico'] });
    const uc = new AssignRecaptureLead(repo, userLookup, roleLookup);

    await expect(uc.execute(lead.id, 'mixed-user')).rejects.toThrow(RecaptureAssigneeNotAllowedError);
  });

  it('validates existence BEFORE roles — a ghost user throws ReferenceNotFoundError, not the pool error', async () => {
    const repo = makeRepo();
    const lead = await seedFreeLead(repo);
    const userLookup = makeUserLookup([]); // ghost: does not exist
    const roleLookup = makeRoleLookup({});
    const uc = new AssignRecaptureLead(repo, userLookup, roleLookup);

    await expect(uc.execute(lead.id, 'ghost-user')).rejects.toThrow(ReferenceNotFoundError);
  });
});
