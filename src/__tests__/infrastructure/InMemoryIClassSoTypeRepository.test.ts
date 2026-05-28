/**
 * TDD — InMemoryIClassSoTypeRepository (iclass-so-type-mapping, FASE 2)
 * Covers the scenarios required by REQ-SYNC-1 (upsert, deactivate, reactivate).
 */
import { InMemoryIClassSoTypeRepository } from '../../infrastructure/adapters/in-memory/InMemoryIClassSoTypeRepository';

const NOW = new Date('2026-05-28T10:00:00Z');

function makeInput(code: string, description = `Desc for ${code}`) {
  return { code, description };
}

describe('InMemoryIClassSoTypeRepository', () => {
  let repo: InMemoryIClassSoTypeRepository;

  beforeEach(() => {
    repo = new InMemoryIClassSoTypeRepository();
  });

  // ── upsertMany ──────────────────────────────────────────────────────────────

  it('upsertMany creates new entries (created count)', async () => {
    const result = await repo.upsertMany([makeInput('A'), makeInput('B')], NOW);
    expect(result.created).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.reactivated).toBe(0);
  });

  it('upsertMany updates existing entries on second call (updated count)', async () => {
    await repo.upsertMany([makeInput('A')], NOW);
    const result = await repo.upsertMany([makeInput('A', 'Updated A')], NOW);
    expect(result.created).toBe(0);
    expect(result.updated).toBe(1);
    expect(result.reactivated).toBe(0);

    const a = await repo.getByCode('A');
    expect(a!.description).toBe('Updated A');
  });

  it('upsertMany reactivates previously inactive entries', async () => {
    await repo.upsertMany([makeInput('A')], NOW);
    await repo.deactivateMissing([]); // deactivate A
    const aInactive = await repo.getByCode('A');
    expect(aInactive!.active).toBe(false);

    const result = await repo.upsertMany([makeInput('A', 'Reactivated A')], NOW);
    expect(result.reactivated).toBe(1);
    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);

    const aActive = await repo.getByCode('A');
    expect(aActive!.active).toBe(true);
    expect(aActive!.description).toBe('Reactivated A');
  });

  it('upsertMany updates lastSyncedAt', async () => {
    const t1 = new Date('2026-05-28T10:00:00Z');
    const t2 = new Date('2026-05-28T11:00:00Z');
    await repo.upsertMany([makeInput('A')], t1);
    await repo.upsertMany([makeInput('A')], t2);
    const a = await repo.getByCode('A');
    expect(a!.lastSyncedAt.toISOString()).toBe(t2.toISOString());
  });

  // ── deactivateMissing ───────────────────────────────────────────────────────

  it('deactivateMissing marks as inactive codes not in presentCodes', async () => {
    await repo.upsertMany([makeInput('A'), makeInput('B'), makeInput('C')], NOW);
    const count = await repo.deactivateMissing(['A']); // B and C should be deactivated
    expect(count).toBe(2);

    const b = await repo.getByCode('B');
    const c = await repo.getByCode('C');
    expect(b!.active).toBe(false);
    expect(c!.active).toBe(false);

    const a = await repo.getByCode('A');
    expect(a!.active).toBe(true);
  });

  it('deactivateMissing with all present → deactivates nothing', async () => {
    await repo.upsertMany([makeInput('A'), makeInput('B')], NOW);
    const count = await repo.deactivateMissing(['A', 'B']);
    expect(count).toBe(0);
  });

  it('deactivateMissing does not re-deactivate already inactive entries', async () => {
    await repo.upsertMany([makeInput('A'), makeInput('B')], NOW);
    await repo.deactivateMissing(['A']); // B deactivated
    const count = await repo.deactivateMissing([]); // A should be deactivated, B already is
    expect(count).toBe(1); // only A is deactivated this time
  });

  // ── list ────────────────────────────────────────────────────────────────────

  it('list() without filter returns all entries', async () => {
    await repo.upsertMany([makeInput('A'), makeInput('B')], NOW);
    await repo.deactivateMissing(['A']); // B deactivated
    const all = await repo.list();
    expect(all).toHaveLength(2);
  });

  it('list({ active: true }) returns only active entries', async () => {
    await repo.upsertMany([makeInput('A'), makeInput('B'), makeInput('C')], NOW);
    await repo.deactivateMissing(['A']); // B and C deactivated
    const active = await repo.list({ active: true });
    expect(active).toHaveLength(1);
    expect(active[0].code).toBe('A');
  });

  it('list({ active: false }) returns only inactive entries', async () => {
    await repo.upsertMany([makeInput('A'), makeInput('B')], NOW);
    await repo.deactivateMissing(['A']); // B deactivated
    const inactive = await repo.list({ active: false });
    expect(inactive).toHaveLength(1);
    expect(inactive[0].code).toBe('B');
  });

  // ── getById / getByCode ─────────────────────────────────────────────────────

  it('getById returns null when id does not exist', async () => {
    expect(await repo.getById('nonexistent-uuid')).toBeNull();
  });

  it('getByCode returns null when code does not exist', async () => {
    expect(await repo.getByCode('NONEXISTENT')).toBeNull();
  });

  it('getById returns the entry after upsert', async () => {
    await repo.upsertMany([makeInput('A')], NOW);
    const a = await repo.getByCode('A');
    expect(a).not.toBeNull();
    const byId = await repo.getById(a!.id);
    expect(byId).not.toBeNull();
    expect(byId!.code).toBe('A');
  });

  it('getByCode returns the entry after upsert', async () => {
    await repo.upsertMany([makeInput('VISITA TECNICA')], NOW);
    const entry = await repo.getByCode('VISITA TECNICA');
    expect(entry).not.toBeNull();
    expect(entry!.description).toBe('Desc for VISITA TECNICA');
    expect(entry!.active).toBe(true);
  });

  // ── full sync cycle (REQ-SYNC-1 scenario) ──────────────────────────────────

  it('full sync cycle: initial → partial removal → reappearance', async () => {
    // Round 1: 3 types
    const round1 = await repo.upsertMany([makeInput('A'), makeInput('B'), makeInput('C')], NOW);
    const deact1 = await repo.deactivateMissing(['A', 'B', 'C']);
    expect(round1.created).toBe(3);
    expect(deact1).toBe(0);

    // Round 2: C disappears
    const round2 = await repo.upsertMany([makeInput('A'), makeInput('B')], NOW);
    const deact2 = await repo.deactivateMissing(['A', 'B']);
    expect(round2.updated).toBe(2);
    expect(deact2).toBe(1); // C deactivated
    expect((await repo.getByCode('C'))!.active).toBe(false);

    // Round 3: C reappears
    const round3 = await repo.upsertMany([makeInput('A'), makeInput('B'), makeInput('C')], NOW);
    const deact3 = await repo.deactivateMissing(['A', 'B', 'C']);
    expect(round3.reactivated).toBe(1); // C reactivated
    expect(deact3).toBe(0);
    expect((await repo.getByCode('C'))!.active).toBe(true);
  });
});
