/**
 * Unit tests for AssignRecaptureLeadsBulk use case.
 * Uses InMemoryRecaptureRepository and a stub EntityLookup — no Prisma.
 */
import { InMemoryRecaptureRepository } from '../../../infrastructure/adapters/in-memory/InMemoryRecaptureRepository';
import { AssignRecaptureLeadsBulk } from '../../../application/use-cases/recapture/AssignRecaptureLeadsBulk';
import { ReferenceNotFoundError } from '../../../domain/errors/scheduling';
import type { EntityLookup } from '../../../domain/ports/EntityLookup';

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

describe('AssignRecaptureLeadsBulk', () => {
  it('assigns N leads to an operator — returns { assigned: N }', async () => {
    const repo = makeRepo();
    const l1 = await repo.create({ source: 'csv', contactName: 'Alpha' });
    const l2 = await repo.create({ source: 'csv', contactName: 'Beta' });
    const l3 = await repo.create({ source: 'csv', contactName: 'Gamma' });
    const lookup = makeUserLookup(['op-1']);
    const uc = new AssignRecaptureLeadsBulk(repo, lookup);

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
    const uc = new AssignRecaptureLeadsBulk(repo, lookup);

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
    const uc = new AssignRecaptureLeadsBulk(repo, lookup);

    await expect(uc.execute(['lead-001'], 'ghost-user')).rejects.toThrow(ReferenceNotFoundError);
  });

  it('partial non-existent leadIds — only counts existing (assigned=1 when 1 exists, 1 not)', async () => {
    const repo = makeRepo();
    const l1 = await repo.create({ source: 'csv', contactName: 'Alpha' });
    const lookup = makeUserLookup(['op-1']);
    const uc = new AssignRecaptureLeadsBulk(repo, lookup);

    const result = await uc.execute([l1.id, 'nonexistent-id'], 'op-1');

    expect(result).toEqual({ assigned: 1 });
  });

  it('skips user lookup when operatorId is null', async () => {
    const repo = makeRepo();
    const l1 = await repo.create({ source: 'csv', contactName: 'Alpha' });
    const lookup: EntityLookup = {
      findById: jest.fn().mockRejectedValue(new Error('should not be called')),
    };
    const uc = new AssignRecaptureLeadsBulk(repo, lookup);

    // Should not throw even though lookup would fail
    await expect(uc.execute([l1.id], null)).resolves.toEqual({ assigned: 1 });
    expect(lookup.findById).not.toHaveBeenCalled();
  });
});
