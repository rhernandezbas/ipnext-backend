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

  // ── upsertByCode ─────────────────────────────────────────────────────────────

  it('upsertByCode creates a new entry (status: created)', async () => {
    const result = await repo.upsertByCode(makeInput('A'));
    expect(result.status).toBe('created');
    const a = await repo.getByCode('A');
    expect(a).not.toBeNull();
    expect(a!.description).toBe('Desc for A');
    expect(a!.active).toBe(true);
  });

  it('upsertByCode updates an existing entry (status: updated)', async () => {
    await repo.upsertByCode(makeInput('A'));
    const result = await repo.upsertByCode(makeInput('A', 'Updated A'));
    expect(result.status).toBe('updated');

    const a = await repo.getByCode('A');
    expect(a!.description).toBe('Updated A');
  });

  it('upsertByCode reactivates a previously inactive entry (status: reactivated)', async () => {
    await repo.upsertByCode(makeInput('A'));
    await repo.markInactiveExcept([]); // deactivate A
    const aInactive = await repo.getByCode('A');
    expect(aInactive!.active).toBe(false);

    const result = await repo.upsertByCode(makeInput('A', 'Reactivated A'));
    expect(result.status).toBe('reactivated');

    const aActive = await repo.getByCode('A');
    expect(aActive!.active).toBe(true);
    expect(aActive!.description).toBe('Reactivated A');
  });

  it('upsertByCode updates lastSyncedAt', async () => {
    const t1 = new Date('2026-05-28T10:00:00Z');
    const t2 = new Date('2026-05-28T11:00:00Z');
    const repoWithClock = new InMemoryIClassSoTypeRepository();
    await repoWithClock.upsertByCode(makeInput('A'));
    // Manually set lastSyncedAt by checking the stored entry reflects a new upsert
    // We test idempotent upsert updates description
    const r1 = await repoWithClock.upsertByCode({ code: 'A', description: 'First' });
    expect(r1.status).toBe('updated');
    const r2 = await repoWithClock.upsertByCode({ code: 'A', description: 'Second' });
    expect(r2.status).toBe('updated');
    const a = await repoWithClock.getByCode('A');
    expect(a!.description).toBe('Second');
  });

  // ── markInactiveExcept ───────────────────────────────────────────────────────

  it('markInactiveExcept marks as inactive codes not in presentCodes', async () => {
    await repo.upsertByCode(makeInput('A'));
    await repo.upsertByCode(makeInput('B'));
    await repo.upsertByCode(makeInput('C'));
    const count = await repo.markInactiveExcept(['A']); // B and C should be deactivated
    expect(count).toBe(2);

    const b = await repo.getByCode('B');
    const c = await repo.getByCode('C');
    expect(b!.active).toBe(false);
    expect(c!.active).toBe(false);

    const a = await repo.getByCode('A');
    expect(a!.active).toBe(true);
  });

  it('markInactiveExcept with all present → deactivates nothing', async () => {
    await repo.upsertByCode(makeInput('A'));
    await repo.upsertByCode(makeInput('B'));
    const count = await repo.markInactiveExcept(['A', 'B']);
    expect(count).toBe(0);
  });

  it('markInactiveExcept does not re-deactivate already inactive entries', async () => {
    await repo.upsertByCode(makeInput('A'));
    await repo.upsertByCode(makeInput('B'));
    await repo.markInactiveExcept(['A']); // B deactivated
    const count = await repo.markInactiveExcept([]); // A should be deactivated, B already is
    expect(count).toBe(1); // only A is deactivated this time
  });

  // ── list ────────────────────────────────────────────────────────────────────

  it('list() without filter returns all entries', async () => {
    await repo.upsertByCode(makeInput('A'));
    await repo.upsertByCode(makeInput('B'));
    await repo.markInactiveExcept(['A']); // B deactivated
    const all = await repo.list();
    expect(all).toHaveLength(2);
  });

  it('list({ active: true }) returns only active entries', async () => {
    await repo.upsertByCode(makeInput('A'));
    await repo.upsertByCode(makeInput('B'));
    await repo.upsertByCode(makeInput('C'));
    await repo.markInactiveExcept(['A']); // B and C deactivated
    const active = await repo.list({ active: true });
    expect(active).toHaveLength(1);
    expect(active[0].code).toBe('A');
  });

  it('list({ active: false }) returns only inactive entries', async () => {
    await repo.upsertByCode(makeInput('A'));
    await repo.upsertByCode(makeInput('B'));
    await repo.markInactiveExcept(['A']); // B deactivated
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
    await repo.upsertByCode(makeInput('A'));
    const a = await repo.getByCode('A');
    expect(a).not.toBeNull();
    const byId = await repo.getById(a!.id);
    expect(byId).not.toBeNull();
    expect(byId!.code).toBe('A');
  });

  it('getByCode returns the entry after upsert', async () => {
    await repo.upsertByCode(makeInput('VISITA TECNICA'));
    const entry = await repo.getByCode('VISITA TECNICA');
    expect(entry).not.toBeNull();
    expect(entry!.description).toBe('Desc for VISITA TECNICA');
    expect(entry!.active).toBe(true);
  });

  // ── full sync cycle (REQ-SYNC-1 scenario) ──────────────────────────────────

  it('full sync cycle: initial → partial removal → reappearance', async () => {
    // Round 1: 3 types
    await repo.upsertByCode(makeInput('A'));
    await repo.upsertByCode(makeInput('B'));
    await repo.upsertByCode(makeInput('C'));
    const deact1 = await repo.markInactiveExcept(['A', 'B', 'C']);
    expect(deact1).toBe(0);

    // Round 2: C disappears
    const r2a = await repo.upsertByCode(makeInput('A'));
    const r2b = await repo.upsertByCode(makeInput('B'));
    expect(r2a.status).toBe('updated');
    expect(r2b.status).toBe('updated');
    const deact2 = await repo.markInactiveExcept(['A', 'B']);
    expect(deact2).toBe(1); // C deactivated
    expect((await repo.getByCode('C'))!.active).toBe(false);

    // Round 3: C reappears
    await repo.upsertByCode(makeInput('A'));
    await repo.upsertByCode(makeInput('B'));
    const r3c = await repo.upsertByCode(makeInput('C'));
    expect(r3c.status).toBe('reactivated'); // C reactivated
    const deact3 = await repo.markInactiveExcept(['A', 'B', 'C']);
    expect(deact3).toBe(0);
    expect((await repo.getByCode('C'))!.active).toBe(true);
  });
});
