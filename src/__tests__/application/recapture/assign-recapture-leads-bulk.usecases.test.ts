/**
 * Unit tests for AssignRecaptureLeadsBulk use case.
 * Uses InMemoryRecaptureRepository + stub EntityLookup + stub UserRoleLookup — no Prisma.
 *
 * recapture-assignable-roles: the target's role set is checked ONCE before the
 * loop. A non-assignable target (no roles OR any technical role) throws
 * RecaptureAssigneeNotAllowedError and leaves EVERY lead untouched.
 */
import { InMemoryRecaptureRepository } from '../../../infrastructure/adapters/in-memory/InMemoryRecaptureRepository';
import { AssignRecaptureLeadsBulk } from '../../../application/use-cases/recapture/AssignRecaptureLeadsBulk';
import { ReferenceNotFoundError } from '../../../domain/errors/scheduling';
import { RecaptureAssigneeNotAllowedError } from '../../../domain/errors/recapture';
import type { EntityLookup } from '../../../domain/ports/EntityLookup';
import type { UserRoleLookup } from '../../../domain/ports/UserRoleLookup';

function makeRepo(): InMemoryRecaptureRepository {
  const repo = new InMemoryRecaptureRepository();
  repo.reset();
  return repo;
}

function makeUserLookup(knownIds: string[]): EntityLookup {
  return {
    findById: async (id: string) =>
      knownIds.includes(id) ? { id, name: `Operator ${id}` } : null,
  };
}

function makeRoleLookup(rolesById: Record<string, string[]>): UserRoleLookup {
  return {
    listRoleCodes: async (userId: string) => rolesById[userId] ?? [],
  };
}

function ventasRoleLookup(): UserRoleLookup {
  return { listRoleCodes: async () => ['ventas'] };
}

describe('AssignRecaptureLeadsBulk', () => {
  it('assigns N leads to an operator — returns { assigned: N }', async () => {
    const repo = makeRepo();
    const l1 = await repo.create({ source: 'csv', contactName: 'Alpha' });
    const l2 = await repo.create({ source: 'csv', contactName: 'Beta' });
    const l3 = await repo.create({ source: 'csv', contactName: 'Gamma' });
    const lookup = makeUserLookup(['op-1']);
    const uc = new AssignRecaptureLeadsBulk(repo, lookup, ventasRoleLookup());

    const result = await uc.execute([l1.id, l2.id, l3.id], 'op-1');

    expect(result).toEqual({ assigned: 3 });
    // Verify leads are actually assigned
    const detail = await repo.getById(l1.id);
    expect(detail!.assigneeId).toBe('op-1');
    expect(detail!.status).toBe('en_gestion');
  });

  it('operatorId null — unassigns (assigns null) and returns correct count', async () => {
    const repo = makeRepo();
    const l1 = await repo.create({ source: 'csv', contactName: 'Alpha' });
    const l2 = await repo.create({ source: 'csv', contactName: 'Beta' });
    await repo.claim(l1.id, 'op-1');
    await repo.claim(l2.id, 'op-2');

    const lookup = makeUserLookup([]);
    const uc = new AssignRecaptureLeadsBulk(repo, lookup, ventasRoleLookup());

    const result = await uc.execute([l1.id, l2.id], null);

    expect(result).toEqual({ assigned: 2 });
    const detail = await repo.getById(l1.id);
    expect(detail!.assigneeId).toBeNull();
    expect(detail!.status).toBe('nuevo');
  });

  it('operatorId does not exist in lookup → throws ReferenceNotFoundError', async () => {
    const repo = makeRepo();
    await repo.create({ source: 'csv', contactName: 'Alpha' });
    const lookup = makeUserLookup([]);
    const uc = new AssignRecaptureLeadsBulk(repo, lookup, ventasRoleLookup());

    await expect(uc.execute(['lead-001'], 'ghost-user')).rejects.toThrow(ReferenceNotFoundError);
  });

  it('partial non-existent leadIds — only counts existing (assigned=1 when 1 exists, 1 not)', async () => {
    const repo = makeRepo();
    const l1 = await repo.create({ source: 'csv', contactName: 'Alpha' });
    const lookup = makeUserLookup(['op-1']);
    const uc = new AssignRecaptureLeadsBulk(repo, lookup, ventasRoleLookup());

    const result = await uc.execute([l1.id, 'nonexistent-id'], 'op-1');

    expect(result).toEqual({ assigned: 1 });
  });

  it('skips user + role lookup when operatorId is null', async () => {
    const repo = makeRepo();
    const l1 = await repo.create({ source: 'csv', contactName: 'Alpha' });
    const lookup: EntityLookup = {
      findById: jest.fn().mockRejectedValue(new Error('should not be called')),
    };
    const roleLookup: UserRoleLookup = {
      listRoleCodes: jest.fn().mockRejectedValue(new Error('should not be called')),
    };
    const uc = new AssignRecaptureLeadsBulk(repo, lookup, roleLookup);

    // Should not throw even though both lookups would fail
    await expect(uc.execute([l1.id], null)).resolves.toEqual({ assigned: 1 });
    expect(lookup.findById).not.toHaveBeenCalled();
    expect(roleLookup.listRoleCodes).not.toHaveBeenCalled();
  });

  // ─── recapture-assignable-roles: pre-loop pool enforcement ──────────────────

  it('technical target → throws RecaptureAssigneeNotAllowedError and NO lead is changed', async () => {
    const repo = makeRepo();
    const l1 = await repo.create({ source: 'csv', contactName: 'Alpha' });
    const l2 = await repo.create({ source: 'csv', contactName: 'Beta' });
    const lookup = makeUserLookup(['tech-user']);
    const roleLookup = makeRoleLookup({ 'tech-user': ['tecnico'] });
    const uc = new AssignRecaptureLeadsBulk(repo, lookup, roleLookup);

    await expect(uc.execute([l1.id, l2.id], 'tech-user')).rejects.toThrow(RecaptureAssigneeNotAllowedError);

    // Pre-loop check ⇒ nothing was mutated.
    const d1 = await repo.getById(l1.id);
    const d2 = await repo.getById(l2.id);
    expect(d1!.assigneeId).toBeNull();
    expect(d1!.status).toBe('nuevo');
    expect(d2!.assigneeId).toBeNull();
    expect(d2!.status).toBe('nuevo');
  });

  it('target with NO roles → throws RecaptureAssigneeNotAllowedError', async () => {
    const repo = makeRepo();
    const l1 = await repo.create({ source: 'csv', contactName: 'Alpha' });
    const lookup = makeUserLookup(['no-role-user']);
    const roleLookup = makeRoleLookup({ 'no-role-user': [] });
    const uc = new AssignRecaptureLeadsBulk(repo, lookup, roleLookup);

    await expect(uc.execute([l1.id], 'no-role-user')).rejects.toThrow(RecaptureAssigneeNotAllowedError);
  });

  it('noc target is allowed in bulk (only tecnico is excluded)', async () => {
    const repo = makeRepo();
    const l1 = await repo.create({ source: 'csv', contactName: 'Alpha' });
    const lookup = makeUserLookup(['noc-user']);
    const roleLookup = makeRoleLookup({ 'noc-user': ['noc'] });
    const uc = new AssignRecaptureLeadsBulk(repo, lookup, roleLookup);

    const result = await uc.execute([l1.id], 'noc-user');
    expect(result).toEqual({ assigned: 1 });
  });
});
