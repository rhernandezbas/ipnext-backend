import { BuildFinanceCohortSnapshot } from '@application/use-cases/finance/BuildFinanceCohortSnapshot';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryFinanceCohortSnapshotRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceCohortSnapshotRepository';

async function makeEnv(now: () => Date) {
  const catalogRepo = new InMemoryServiceCatalogRepository();
  const internet = await catalogRepo.create({ name: 'INTERNET' });
  const clock = { now: now() };
  const eventRepo = new InMemoryContractServiceEventRepository({ now: () => clock.now });
  const cohortRepo = new InMemoryFinanceCohortSnapshotRepository();
  const useCase = new BuildFinanceCohortSnapshot(eventRepo, catalogRepo, cohortRepo, () => now());

  async function activate(contractId: string): Promise<void> {
    await eventRepo.record({ contractId, serviceCatalogId: internet.id, eventType: 'activated', actorId: null, actorName: 'sistema' });
  }
  async function deactivate(contractId: string): Promise<void> {
    await eventRepo.record({ contractId, serviceCatalogId: internet.id, eventType: 'deactivated', actorId: null, actorName: 'sistema' });
  }
  async function reactivate(contractId: string): Promise<void> {
    await eventRepo.record({ contractId, serviceCatalogId: internet.id, eventType: 'reactivated', actorId: null, actorName: 'sistema' });
  }

  return { catalogRepo, internet, eventRepo, cohortRepo, useCase, activate, deactivate, reactivate, clock };
}

describe('BuildFinanceCohortSnapshot (design.md Decision 4, spec.md retention cohorts)', () => {
  // 3.21
  it('a cohort of N altas in a month: survivingCount at 3 months correctly counts contracts WITHOUT a deactivated event before the cutoff', async () => {
    // "now" is well past the 3-month cutoff (June) so the row can be generated.
    const env = await makeEnv(() => new Date('2026-06-15T12:00:00.000Z'));
    env.clock.now = new Date('2026-01-10T12:00:00.000Z');
    for (const id of ['c1', 'c2', 'c3', 'c4', 'c5']) await env.activate(id);

    // 2 of the 5 churn BEFORE the April cutoff (3 months after January).
    env.clock.now = new Date('2026-03-20T12:00:00.000Z');
    await env.deactivate('c1');
    await env.deactivate('c2');

    // A survivor that churns AFTER the cutoff should still count as surviving AT the cutoff.
    env.clock.now = new Date('2026-05-01T12:00:00.000Z');
    await env.deactivate('c3');

    const rows = await env.useCase.execute('2026-01');
    const m3 = rows.find((r) => r.monthsElapsed === 3)!;

    expect(m3.originalCount).toBe(5);
    expect(m3.survivingCount).toBe(3); // c3, c4, c5 (c3 churned AFTER month 3's cutoff)
  });

  // 3.22
  it('a cohort younger than 12 months does NOT generate a monthsElapsed:12 row (never invents unearned data)', async () => {
    // "now" is 5 months after the cohort month — old enough for 3, not for 6 or 12.
    const env = await makeEnv(() => new Date('2026-06-10T12:00:00.000Z'));
    env.clock.now = new Date('2026-01-10T12:00:00.000Z');
    await env.activate('c1');

    const rows = await env.useCase.execute('2026-01');

    expect(rows.map((r) => r.monthsElapsed)).toEqual([3]);
    expect(rows.find((r) => r.monthsElapsed === 6)).toBeUndefined();
    expect(rows.find((r) => r.monthsElapsed === 12)).toBeUndefined();
  });

  it('a cohort old enough for all three ages generates 3/6/12 rows, persisted idempotently', async () => {
    const env = await makeEnv(() => new Date('2027-06-01T12:00:00.000Z'));
    env.clock.now = new Date('2026-01-10T12:00:00.000Z');
    await env.activate('c1');
    await env.activate('c2');
    env.clock.now = new Date('2026-08-01T12:00:00.000Z'); // churns between month 6 and month 12
    await env.deactivate('c2');

    await env.useCase.execute('2026-01');
    const rows = await env.useCase.execute('2026-01'); // re-run: idempotent upsert, no duplicates

    expect(rows.map((r) => r.monthsElapsed)).toEqual([3, 6, 12]);
    expect(rows.find((r) => r.monthsElapsed === 3)!.survivingCount).toBe(2);
    expect(rows.find((r) => r.monthsElapsed === 6)!.survivingCount).toBe(2);
    expect(rows.find((r) => r.monthsElapsed === 12)!.survivingCount).toBe(1);
    const stored = await env.cohortRepo.listByCohort('2026-01');
    expect(stored).toHaveLength(3);
  });

  // F8 — a contract whose FIRST recorded event is 'reactivated' (its real
  // 'activated' predates the tracked history, e.g. legacy data, OR it's a
  // genuine baja→reactivación where the true alta is outside this window)
  // must NOT be counted as a brand-new alta of the reactivation's month —
  // that inflates the cohort denominator with a contract that isn't new.
  it('a contract whose only recorded event is reactivated does NOT inflate any cohort (K2)', async () => {
    const env = await makeEnv(() => new Date('2027-06-01T12:00:00.000Z')); // old enough for 3/6/12 everywhere
    env.clock.now = new Date('2026-01-10T12:00:00.000Z');
    await env.activate('c1'); // genuine January cohort member
    env.clock.now = new Date('2026-03-05T12:00:00.000Z');
    // c-legacy's real 'activated' is NOT in this event log at all (legacy
    // client migrated mid-lifecycle) — only a 'reactivated' is ever recorded.
    await env.reactivate('c-legacy');

    const januaryRows = await env.useCase.execute('2026-01');
    const marchRows = await env.useCase.execute('2026-03');

    expect(januaryRows.find((r) => r.monthsElapsed === 3)!.originalCount).toBe(1); // only c1
    // c-legacy belongs to NEITHER cohort — it's not "new" in March either,
    // since we genuinely don't know when it started (never inflates a
    // denominator with a contract of unknown alta date).
    expect(marchRows.every((r) => r.originalCount === 0)).toBe(true);
  });
});
