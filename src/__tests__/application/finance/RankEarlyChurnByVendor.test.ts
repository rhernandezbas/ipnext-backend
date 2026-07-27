import { RankEarlyChurnByVendor } from '@application/use-cases/finance/RankEarlyChurnByVendor';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryContractRepository } from '@infrastructure/adapters/in-memory/InMemoryContractRepository';
import { InMemoryFinanceTargetsConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceTargetsConfigRepository';
import type { ServiceCatalog } from '@domain/entities/service-catalog';

async function makeEnv() {
  const catalogRepo = new InMemoryServiceCatalogRepository();
  const internet: ServiceCatalog = await catalogRepo.create({ name: 'INTERNET' });
  const clock = { now: new Date('2026-03-01T12:00:00.000Z') };
  const eventRepo = new InMemoryContractServiceEventRepository({ now: () => clock.now });
  const contractRepo = new InMemoryContractRepository();
  const targetsRepo = new InMemoryFinanceTargetsConfigRepository();
  targetsRepo.seed({ churnTargetPct: 5, maxPaybackMonths: 12, monthlyNewContractsGoal: 0, inflationBaseYearMonth: '' });
  // fix-wave-4 🟡5 — a SEPARATE "current time" clock from the one that stamps
  // event `createdAt` (`clock` above): altas are backdated by mutating `clock.now`
  // before recording, but "is this alta mature yet" must be judged against
  // "today", a fixed point independent of that backdating dance. Defaults far
  // in the future so every test's altas are mature unless a test overrides it.
  const nowRef = { value: new Date('2030-01-01T00:00:00.000Z') };
  const useCase = new RankEarlyChurnByVendor(eventRepo, catalogRepo, contractRepo, targetsRepo, () => nowRef.value);

  function seedContract(id: string, vendedor: string | null) {
    contractRepo.seed({ id, clientId: id, clientName: `Cliente ${id}`, plan: 'IP-100', vendedor });
    eventRepo.setContractClient(id, id, `Cliente ${id}`);
  }
  async function activate(contractId: string) {
    await eventRepo.record({ contractId, serviceCatalogId: internet.id, eventType: 'activated', actorId: null, actorName: 'sistema' });
  }
  async function reactivate(contractId: string) {
    await eventRepo.record({ contractId, serviceCatalogId: internet.id, eventType: 'reactivated', actorId: null, actorName: 'sistema' });
  }
  async function deactivate(contractId: string) {
    await eventRepo.record({ contractId, serviceCatalogId: internet.id, eventType: 'deactivated', actorId: null, actorName: 'sistema' });
  }

  return { eventRepo, contractRepo, targetsRepo, useCase, seedContract, activate, reactivate, deactivate, clock, nowRef };
}

describe('RankEarlyChurnByVendor (design.md HTTP Contract "GET /vendors/early-churn")', () => {
  it('4.12/4.13 — a vendor with FEWER altas but a HIGHER churn rate ranks FIRST (discriminating fixture: volume alone would rank the OTHER vendor first)', async () => {
    const env = await makeEnv();

    // Vendor A: 10 altas, 8 churn early (80%) — LOW volume, HIGH churn rate.
    for (let i = 0; i < 10; i++) {
      const id = `a-${i}`;
      env.seedContract(id, 'Vendedor A');
      env.clock.now = new Date('2026-01-05T12:00:00.000Z');
      await env.activate(id);
      if (i < 8) {
        env.clock.now = new Date('2026-01-20T12:00:00.000Z');
        await env.deactivate(id);
      }
    }

    // Vendor B: 50 altas, 5 churn early (10%) — HIGH volume, LOW churn rate.
    // A pure volume-based (or count-based) ranking would put B first —
    // this is exactly the discrimination the tautological fix-wave-3 fixture
    // (50/60% vs 20/5%, where A won on BOTH criteria) never actually tested.
    for (let i = 0; i < 50; i++) {
      const id = `b-${i}`;
      env.seedContract(id, 'Vendedor B');
      env.clock.now = new Date('2026-01-05T12:00:00.000Z');
      await env.activate(id);
      if (i < 5) {
        env.clock.now = new Date('2026-01-20T12:00:00.000Z');
        await env.deactivate(id);
      }
    }

    const result = await env.useCase.execute('2026-01', '2026-01');

    const a = result.vendors.find((v) => v.vendedor === 'Vendedor A')!;
    const b = result.vendors.find((v) => v.vendedor === 'Vendedor B')!;
    expect(a.altasTotal).toBe(10);
    expect(a.altasChurneadasTemprano).toBe(8);
    expect(a.earlyChurnPct).toBe(80);
    expect(b.altasTotal).toBe(50);
    expect(b.altasChurneadasTemprano).toBe(5);
    expect(b.earlyChurnPct).toBe(10);
    // B has 5x the altas of A but ranks SECOND — the ranking is by RATE.
    expect(result.vendors[0].vendedor).toBe('Vendedor A');
  });

  it('a deactivation OUTSIDE the "temprano" window does not count as early churn', async () => {
    const env = await makeEnv();
    env.targetsRepo.seed({ churnTargetPct: 5, maxPaybackMonths: 1, monthlyNewContractsGoal: 0, inflationBaseYearMonth: '' });
    env.seedContract('late-churn', 'Vendedor C');
    env.clock.now = new Date('2026-03-01T12:00:00.000Z');
    await env.activate('late-churn');
    env.clock.now = new Date('2026-06-01T12:00:00.000Z'); // 3 months later — outside a 1-month window
    await env.deactivate('late-churn');

    const result = await env.useCase.execute('2026-03', '2026-03');

    expect(result.vendors).toEqual([{ vendedor: 'Vendedor C', altasTotal: 1, altasChurneadasTemprano: 0, earlyChurnPct: 0, altasMaduras: 1 }]);
  });

  it('a contract with no vendedor groups under "sin vendedor", never dropped', async () => {
    const env = await makeEnv();
    env.seedContract('no-vendor', null);
    await env.activate('no-vendor');

    const result = await env.useCase.execute('2026-03', '2026-03');

    expect(result.vendors).toEqual([{ vendedor: 'sin vendedor', altasTotal: 1, altasChurneadasTemprano: 0, earlyChurnPct: 0, altasMaduras: 1 }]);
  });

  it('fix-wave-4 🟡11 — a whitespace-only vendedor ("   ") groups under "sin vendedor", not its own bucket', async () => {
    const env = await makeEnv();
    env.seedContract('blank-vendor', '   ');
    await env.activate('blank-vendor');

    const result = await env.useCase.execute('2026-03', '2026-03');

    expect(result.vendors).toEqual([{ vendedor: 'sin vendedor', altasTotal: 1, altasChurneadasTemprano: 0, earlyChurnPct: 0, altasMaduras: 1 }]);
  });

  it('fix-wave-4 🔴4 — the "temprano" cutoff is measured from the REAL alta INSTANT, not floored to the 1st of its month: an alta on the 31st gets its FULL window', async () => {
    const env = await makeEnv();
    env.targetsRepo.seed({ churnTargetPct: 5, maxPaybackMonths: 6, monthlyNewContractsGoal: 0, inflationBaseYearMonth: '' });

    // Alta on the 31st: true cutoff = 2026-07-31. The OLD (buggy) code floored
    // to the month first (2026-01) then added 6 months from the 1st, cutting
    // the cutoff off at 2026-07-01 — a full 30 days short.
    env.seedContract('end-of-month', 'Vendedor EOM');
    env.clock.now = new Date('2026-01-31T12:00:00.000Z');
    await env.activate('end-of-month');
    env.clock.now = new Date('2026-07-10T12:00:00.000Z'); // ~160 days later — inside the TRUE window, outside the buggy one.
    await env.deactivate('end-of-month');

    // Same absolute deactivation date, but an alta on the 1st: true cutoff =
    // 2026-07-01 — this one correctly does NOT count, under either version.
    env.seedContract('start-of-month', 'Vendedor SOM');
    env.clock.now = new Date('2026-01-01T12:00:00.000Z');
    await env.activate('start-of-month');
    env.clock.now = new Date('2026-07-10T12:00:00.000Z'); // ~190 days later — outside its own window.
    await env.deactivate('start-of-month');

    const result = await env.useCase.execute('2026-01', '2026-01');

    const eom = result.vendors.find((v) => v.vendedor === 'Vendedor EOM')!;
    const som = result.vendors.find((v) => v.vendedor === 'Vendedor SOM')!;
    expect(eom.altasChurneadasTemprano).toBe(1); // WAS 0 under the month-floored bug
    expect(eom.earlyChurnPct).toBe(100);
    expect(som.altasChurneadasTemprano).toBe(0);
    expect(som.earlyChurnPct).toBe(0);
  });

  it('fix-wave-4 🟡5 — altasMaduras is the denominator: 10 mature altas (5 churned early = 50% real) do NOT get diluted by 10 immature altas from "last week"', async () => {
    const env = await makeEnv();
    env.targetsRepo.seed({ churnTargetPct: 5, maxPaybackMonths: 6, monthlyNewContractsGoal: 0, inflationBaseYearMonth: '' });
    env.nowRef.value = new Date('2026-09-01T00:00:00.000Z'); // "today" — far enough that the January altas' 6-month window has closed.

    // 10 MATURE altas (activated 2026-01, cutoff 2026-07 — long past by "now"), 5 churn early.
    for (let i = 0; i < 10; i++) {
      const id = `maduro-${i}`;
      env.seedContract(id, 'Novato');
      env.clock.now = new Date('2026-01-05T12:00:00.000Z');
      await env.activate(id);
      if (i < 5) {
        env.clock.now = new Date('2026-01-20T12:00:00.000Z');
        await env.deactivate(id);
      }
    }
    // 10 IMMATURE altas activated "last week" relative to "now" (2026-09-01) —
    // their 6-month window (cutoff ~2027-02) has NOT closed, none have churned.
    for (let i = 0; i < 10; i++) {
      const id = `nuevo-${i}`;
      env.seedContract(id, 'Novato');
      env.clock.now = new Date('2026-08-25T12:00:00.000Z');
      await env.activate(id);
    }

    const result = await env.useCase.execute('2026-01', '2026-08');

    const novato = result.vendors.find((v) => v.vendedor === 'Novato')!;
    expect(novato.altasTotal).toBe(20);
    // The old lie: denominator = 20 (altasTotal) => 25%, burying "Novato" last
    // for having 10 altas too recent to have had a chance to fail yet.
    expect(novato.altasMaduras).toBe(10);
    expect(novato.altasChurneadasTemprano).toBe(5);
    expect(novato.earlyChurnPct).toBe(50);
  });

  it('earlyChurnPct is null (never 0) when EVERY alta is still immature — "no data yet" is not the same as "0% churn"', async () => {
    const env = await makeEnv();
    env.targetsRepo.seed({ churnTargetPct: 5, maxPaybackMonths: 12, monthlyNewContractsGoal: 0, inflationBaseYearMonth: '' });
    env.nowRef.value = new Date('2026-03-05T00:00:00.000Z'); // just days after the alta — nowhere near the 12-month cutoff.
    env.seedContract('brand-new', 'Vendedor Nuevo');
    env.clock.now = new Date('2026-03-01T12:00:00.000Z');
    await env.activate('brand-new');

    const result = await env.useCase.execute('2026-03', '2026-03');

    const v = result.vendors.find((v) => v.vendedor === 'Vendedor Nuevo')!;
    expect(v.altasMaduras).toBe(0);
    expect(v.earlyChurnPct).toBeNull();
  });

  it('fix-wave-4 🟡8 — a contract with BOTH an "activated" and a "reactivated" event in-range counts as ONE alta, never two (same dedup criterion ComputeCacAndPayback already applies)', async () => {
    const env = await makeEnv();
    env.seedContract('flappy', 'Vendedor D');
    env.clock.now = new Date('2026-03-05T12:00:00.000Z');
    await env.activate('flappy');
    env.clock.now = new Date('2026-03-10T12:00:00.000Z');
    await env.deactivate('flappy');
    env.clock.now = new Date('2026-03-15T12:00:00.000Z');
    await env.reactivate('flappy');

    const result = await env.useCase.execute('2026-03', '2026-03');

    const v = result.vendors.find((v) => v.vendedor === 'Vendedor D')!;
    expect(v.altasTotal).toBe(1); // NOT 2 — activated + reactivated is the SAME contract's one sale.
  });

  it('a matured alta that already churned early is counted in BOTH altasChurneadasTemprano and altasMaduras, even if queried before its own window technically elapsed — a sealed verdict never waits', async () => {
    const env = await makeEnv();
    env.targetsRepo.seed({ churnTargetPct: 5, maxPaybackMonths: 12, monthlyNewContractsGoal: 0, inflationBaseYearMonth: '' });
    env.nowRef.value = new Date('2026-03-20T00:00:00.000Z'); // "now" — the 12-month window has NOT elapsed yet.
    env.seedContract('early-churner', 'Vendedor E');
    env.clock.now = new Date('2026-03-01T12:00:00.000Z');
    await env.activate('early-churner');
    env.clock.now = new Date('2026-03-10T12:00:00.000Z');
    await env.deactivate('early-churner'); // already churned — the verdict is sealed regardless of the 12-month window not being over.

    const result = await env.useCase.execute('2026-03', '2026-03');

    const v = result.vendors.find((v) => v.vendedor === 'Vendedor E')!;
    expect(v.altasMaduras).toBe(1);
    expect(v.altasChurneadasTemprano).toBe(1);
    expect(v.earlyChurnPct).toBe(100);
  });

  it('rejects malformed range params', async () => {
    const env = await makeEnv();
    await expect(env.useCase.execute('2026-03', '2026-01')).rejects.toThrow();
  });

  it('fix-wave-4 🔵17 — rejects a range wider than 240 months', async () => {
    const env = await makeEnv();
    await expect(env.useCase.execute('1990-01', '2026-12')).rejects.toThrow();
  });
});
