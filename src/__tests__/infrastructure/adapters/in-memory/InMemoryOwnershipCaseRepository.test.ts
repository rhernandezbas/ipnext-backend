import { InMemoryOwnershipCaseRepository } from '@infrastructure/adapters/in-memory/InMemoryOwnershipCaseRepository';
import { CreateOwnershipCaseInput } from '@domain/ports/OwnershipCaseRepository';

function input(overrides: Partial<CreateOwnershipCaseInput> = {}): CreateOwnershipCaseInput {
  return {
    sourceContractId: 'c-old',
    sourceClientId: 'cli-1',
    motivoBaja: 'CAMBIO DE TITULARIDAD',
    status: 'pending',
    ...overrides,
  };
}

describe('InMemoryOwnershipCaseRepository', () => {
  let repo: InMemoryOwnershipCaseRepository;

  beforeEach(() => {
    repo = new InMemoryOwnershipCaseRepository();
  });

  it('create + getById roundtrip with defaults for omitted fields', async () => {
    const created = await repo.create(input({ targetContractId: 'c-new', targetClientId: 'cli-2' }));

    const found = await repo.getById(created.id);
    expect(found).not.toBeNull();
    expect(found!.sourceContractId).toBe('c-old');
    expect(found!.sourceClientId).toBe('cli-1');
    expect(found!.motivoBaja).toBe('CAMBIO DE TITULARIDAD');
    expect(found!.targetContractId).toBe('c-new');
    expect(found!.targetClientId).toBe('cli-2');
    expect(found!.status).toBe('pending');
    expect(found!.bajaDate).toBeNull();
    expect(found!.candidates).toBeNull();
    expect(found!.dismissReason).toBeNull();
    expect(found!.equipmentReviewed).toBe(false);
    expect(found!.equipmentReviewedById).toBeNull();
    expect(found!.equipmentReviewedAt).toBeNull();
    expect(found!.detectedAt).toBeTruthy();
    expect(found!.updatedAt).toBeTruthy();
  });

  it('getById returns null for an unknown id', async () => {
    expect(await repo.getById('nope')).toBeNull();
  });

  it('create throws on duplicate sourceContractId (mirrors the DB unique index)', async () => {
    await repo.create(input());

    await expect(repo.create(input())).rejects.toThrow(/sourceContractId/);
  });

  it('existsBySourceContract reflects created cases', async () => {
    expect(await repo.existsBySourceContract('c-old')).toBe(false);
    await repo.create(input());
    expect(await repo.existsBySourceContract('c-old')).toBe(true);
  });

  it('list filters by status and paginates with a stable total', async () => {
    await repo.create(input({ sourceContractId: 'c-1', status: 'pending' }));
    await repo.create(input({ sourceContractId: 'c-2', status: 'ambiguous' }));
    await repo.create(input({ sourceContractId: 'c-3', status: 'pending' }));

    const pending = await repo.list({ status: 'pending', page: 1, pageSize: 1 });
    expect(pending.total).toBe(2);
    expect(pending.items).toHaveLength(1);

    const all = await repo.list({ page: 1, pageSize: 10 });
    expect(all.total).toBe(3);
    expect(all.items).toHaveLength(3);
  });

  it('update patches only the provided fields and returns the updated case', async () => {
    const created = await repo.create(input({ candidates: [{ contractId: 'c-a', clientId: 'cli-2' }], status: 'ambiguous' }));

    const updated = await repo.update(created.id, {
      targetContractId: 'c-a',
      targetClientId: 'cli-2',
      status: 'pending',
    });

    expect(updated).not.toBeNull();
    expect(updated!.targetContractId).toBe('c-a');
    expect(updated!.status).toBe('pending');
    // Untouched fields survive the patch
    expect(updated!.motivoBaja).toBe('CAMBIO DE TITULARIDAD');
    expect(updated!.candidates).toEqual([{ contractId: 'c-a', clientId: 'cli-2' }]);
    expect(new Date(updated!.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(created.updatedAt).getTime());
  });

  it('update supports the manual equipment check with actor and date', async () => {
    const created = await repo.create(input());

    const updated = await repo.update(created.id, {
      equipmentReviewed: true,
      equipmentReviewedById: 'user-7',
      equipmentReviewedAt: '2026-07-10T12:00:00.000Z',
    });

    expect(updated!.equipmentReviewed).toBe(true);
    expect(updated!.equipmentReviewedById).toBe('user-7');
    expect(updated!.equipmentReviewedAt).toBe('2026-07-10T12:00:00.000Z');
  });

  it('update returns null for an unknown id', async () => {
    expect(await repo.update('nope', { status: 'done' })).toBeNull();
  });

  // ─── L7 — paridad de orden con el adapter Prisma ────────────────────────────

  it('list ordena por detectedAt DESC con desempate id ASC (paridad con Prisma)', async () => {
    const base = {
      sourceClientId: 'cli-1',
      motivoBaja: 'CAMBIO DE TITULARIDAD',
      bajaDate: null,
      targetContractId: null,
      targetClientId: null,
      candidates: null,
      status: 'pending' as const,
      dismissReason: null,
      equipmentReviewed: false,
      equipmentReviewedById: null,
      equipmentReviewedAt: null,
      updatedAt: '2026-07-01T00:00:00.000Z',
    };
    repo.seedCase({ ...base, id: 'z-viejo', sourceContractId: 's1', detectedAt: '2026-07-01T00:00:00.000Z' });
    repo.seedCase({ ...base, id: 'b-nuevo', sourceContractId: 's2', detectedAt: '2026-07-03T00:00:00.000Z' });
    repo.seedCase({ ...base, id: 'a-nuevo', sourceContractId: 's3', detectedAt: '2026-07-03T00:00:00.000Z' });

    const result = await repo.list({ page: 1, pageSize: 10 });

    expect(result.items.map((c) => c.id)).toEqual(['a-nuevo', 'b-nuevo', 'z-viejo']);
  });

  // ─── M1 — flipToDone con CAS (compare-and-set) ─────────────────────────────

  describe('flipToDone', () => {
    it('flipea un caso pending+reviewed a done y devuelve true', async () => {
      const created = await repo.create(input());
      await repo.update(created.id, { equipmentReviewed: true });

      const flipped = await repo.flipToDone(created.id);

      expect(flipped).toBe(true);
      expect((await repo.getById(created.id))!.status).toBe('done');
    });

    it('devuelve false SIN tocar el caso cuando el status ya no es pending (dismiss concurrente)', async () => {
      const created = await repo.create(input());
      await repo.update(created.id, { equipmentReviewed: true, status: 'dismissed', dismissReason: 'x' });

      const flipped = await repo.flipToDone(created.id);

      expect(flipped).toBe(false);
      expect((await repo.getById(created.id))!.status).toBe('dismissed');
    });

    it('devuelve false cuando equipmentReviewed=false (la condición del flip no se cumple)', async () => {
      const created = await repo.create(input());

      const flipped = await repo.flipToDone(created.id);

      expect(flipped).toBe(false);
      expect((await repo.getById(created.id))!.status).toBe('pending');
    });

    it('devuelve false para un id desconocido', async () => {
      expect(await repo.flipToDone('nope')).toBe(false);
    });
  });

  // ─── H1a — casos prístinos re-pareables por el detector ────────────────────

  describe('listPristineUnpaired', () => {
    it('devuelve SOLO los pending sin target, sin candidates y sin review manual', async () => {
      await repo.create(input({ sourceContractId: 'pristine' })); // sí
      await repo.create(input({ sourceContractId: 'con-target', targetContractId: 'ct-x', targetClientId: 'cli-x' })); // no: target
      await repo.create(input({
        sourceContractId: 'ambiguo',
        status: 'ambiguous',
        candidates: [{ contractId: 'a', clientId: 'ca' }, { contractId: 'b', clientId: 'cb' }],
      })); // no: candidates + status
      const reviewed = await repo.create(input({ sourceContractId: 'revisado' }));
      await repo.update(reviewed.id, { equipmentReviewed: true, equipmentReviewedById: 'u1', equipmentReviewedAt: '2026-07-10T00:00:00.000Z' }); // no: reviewed
      const dismissed = await repo.create(input({ sourceContractId: 'descartado' }));
      await repo.update(dismissed.id, { status: 'dismissed', dismissReason: 'x' }); // no: dismissed

      const pristine = await repo.listPristineUnpaired(10);

      expect(pristine.map((c) => c.sourceContractId)).toEqual(['pristine']);
    });

    it('honra el limit', async () => {
      await repo.create(input({ sourceContractId: 'p1' }));
      await repo.create(input({ sourceContractId: 'p2' }));
      await repo.create(input({ sourceContractId: 'p3' }));

      const pristine = await repo.listPristineUnpaired(2);

      expect(pristine).toHaveLength(2);
    });
  });

  // ─── FIX WAVE 2 — updateIfPristine: CAS del re-pareo ────────────────────────

  describe('updateIfPristine', () => {
    it('aplica el patch y devuelve true cuando el caso sigue prístino', async () => {
      const created = await repo.create(input());

      const ok = await repo.updateIfPristine(created.id, {
        targetContractId: 'ct-2',
        targetClientId: 'cli-2',
      });

      expect(ok).toBe(true);
      const after = (await repo.getById(created.id))!;
      expect(after.targetContractId).toBe('ct-2');
      expect(after.targetClientId).toBe('cli-2');
      expect(after.status).toBe('pending');
    });

    it('false SIN tocar el caso cuando está dismissed (dismiss concurrente)', async () => {
      const created = await repo.create(input());
      await repo.update(created.id, { status: 'dismissed', dismissReason: 'x' });

      const ok = await repo.updateIfPristine(created.id, {
        status: 'ambiguous',
        candidates: [{ contractId: 'a', clientId: 'ca' }],
      });

      expect(ok).toBe(false);
      const after = (await repo.getById(created.id))!;
      expect(after.status).toBe('dismissed');
      expect(after.dismissReason).toBe('x');
      expect(after.candidates).toBeNull();
    });

    it('false SIN tocar el caso cuando ya tiene target (set-target concurrente)', async () => {
      const created = await repo.create(input());
      await repo.update(created.id, { targetContractId: 'ct-manual', targetClientId: 'cli-9' });

      const ok = await repo.updateIfPristine(created.id, {
        targetContractId: 'ct-detector',
        targetClientId: 'cli-2',
      });

      expect(ok).toBe(false);
      expect((await repo.getById(created.id))!.targetContractId).toBe('ct-manual');
    });

    it('false cuando el caso tiene candidates (ya no es prístino)', async () => {
      const created = await repo.create(input({
        status: 'ambiguous',
        candidates: [{ contractId: 'a', clientId: 'ca' }, { contractId: 'b', clientId: 'cb' }],
      }));

      expect(await repo.updateIfPristine(created.id, { targetContractId: 'a' })).toBe(false);
    });

    it('false cuando equipmentReviewed=true (hubo review manual)', async () => {
      const created = await repo.create(input());
      await repo.update(created.id, { equipmentReviewed: true, equipmentReviewedById: 'u1', equipmentReviewedAt: '2026-07-10T00:00:00.000Z' });

      expect(await repo.updateIfPristine(created.id, { targetContractId: 'ct-2' })).toBe(false);
      expect((await repo.getById(created.id))!.targetContractId).toBeNull();
    });

    it('false para un id desconocido', async () => {
      expect(await repo.updateIfPristine('nope', { targetContractId: 'ct-2' })).toBe(false);
    });
  });

  // ─── FIX WAVE 2 — listAllSourceContractIds: exclusión del scan ──────────────

  describe('listAllSourceContractIds', () => {
    it('devuelve los sourceContractIds de TODOS los casos (cualquier status)', async () => {
      await repo.create(input({ sourceContractId: 'c-1' }));
      await repo.create(input({ sourceContractId: 'c-2', status: 'ambiguous', candidates: [{ contractId: 'a', clientId: 'ca' }, { contractId: 'b', clientId: 'cb' }] }));
      const dismissed = await repo.create(input({ sourceContractId: 'c-3' }));
      await repo.update(dismissed.id, { status: 'dismissed', dismissReason: 'x' });

      const ids = await repo.listAllSourceContractIds();

      expect([...ids].sort()).toEqual(['c-1', 'c-2', 'c-3']);
    });

    it('devuelve vacío cuando no hay casos', async () => {
      expect(await repo.listAllSourceContractIds()).toEqual([]);
    });
  });
});
