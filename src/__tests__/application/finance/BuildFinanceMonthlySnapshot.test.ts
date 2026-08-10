import { BuildFinanceMonthlySnapshot } from '@application/use-cases/finance/BuildFinanceMonthlySnapshot';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryPlanRepository } from '@infrastructure/adapters/in-memory/InMemoryPlanRepository';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryClientMirrorReadRepository } from '@infrastructure/adapters/in-memory/InMemoryClientMirrorReadRepository';
import { InMemoryFinancePaymentReceiptRepository } from '@infrastructure/adapters/in-memory/InMemoryFinancePaymentReceiptRepository';
import { InMemoryFinanceReceiptItemRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceReceiptItemRepository';
import { InMemoryFinanceReceiptApplicationRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceReceiptApplicationRepository';
import { InMemoryFinanceInvoiceTypeClassificationRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceInvoiceTypeClassificationRepository';
import { InMemoryFinancePlanPriceRepository } from '@infrastructure/adapters/in-memory/InMemoryFinancePlanPriceRepository';
import { InMemoryFinanceMonthlySnapshotRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceMonthlySnapshotRepository';
import type { ServiceCatalog } from '@domain/entities/service-catalog';

/**
 * finance-growth Fase 3 REWORK (2026-07-27) — "DOS NÚMEROS, DOS PREGUNTAS".
 * Builds a fully-wired test environment. `clockTick` is a mutable box the
 * test advances between `record()` calls so a SINGLE event repo (and hence a
 * single, consistent replay history) can seed events across several months.
 *
 * fix-wave-2 — also wires an `InMemoryPppoeServiceRepository` (`pppoeRepo`),
 * the NEW source `resolvedPlanCodeAt` anchors on. `activate()`/`modify()`
 * below keep it in sync automatically, mirroring what `ChangePppoePlanService`
 * does in production (write the `ContractServiceEvent` AND upsert
 * `PppoeService.profile` in the SAME operation) — no per-test plumbing needed.
 */
async function makeEnv() {
  const catalogRepo = new InMemoryServiceCatalogRepository();
  const internet: ServiceCatalog = await catalogRepo.create({ name: 'INTERNET' });
  const clock = { now: new Date('2026-01-01T12:00:00.000Z') };
  const eventRepo = new InMemoryContractServiceEventRepository({ now: () => clock.now });
  const planRepo = new InMemoryPlanRepository();
  const pppoeRepo = new InMemoryPppoeServiceRepository({ now: () => clock.now });
  const clientLinks = new InMemoryClientMirrorReadRepository();
  const receiptRepo = new InMemoryFinancePaymentReceiptRepository();
  const itemRepo = new InMemoryFinanceReceiptItemRepository(receiptRepo);
  const applicationRepo = new InMemoryFinanceReceiptApplicationRepository(receiptRepo);
  const classificationRepo = new InMemoryFinanceInvoiceTypeClassificationRepository();
  const planPriceRepo = new InMemoryFinancePlanPriceRepository();
  const snapshotRepo = new InMemoryFinanceMonthlySnapshotRepository();

  const useCase = new BuildFinanceMonthlySnapshot(
    eventRepo,
    catalogRepo,
    planRepo,
    pppoeRepo,
    clientLinks,
    itemRepo,
    applicationRepo,
    classificationRepo,
    planPriceRepo,
    snapshotRepo,
  );

  let receiptSeq = 0;
  /** Seeds one receipt + one cash item for `clientGrId`, dated `iso`. */
  async function seedCash(clientGrId: string, iso: string, amount: number): Promise<void> {
    receiptSeq += 1;
    const grReceiptId = `receipt-${receiptSeq}`;
    await receiptRepo.upsertBatch([
      { grReceiptId, clientGrId, recaudador: null, fechaRecibo: new Date(iso), fechaConfirmacion: null, anulado: false, observaciones: null },
    ]);
    await itemRepo.upsertBatch([
      { grItemId: `${grReceiptId}-item-1`, receiptId: grReceiptId, banco: null, cajaCuentaId: null, destino: null, fecha: new Date(iso), amount, moneda: null, numeroTransferencia: null, tipo: null },
    ]);
  }

  function linkClient(clientId: string, grClienteId: string): void {
    clientLinks.grClienteIdByClientId.set(clientId, grClienteId);
  }

  /**
   * Activates `contractId` for `clientId`/`grClienteId` at the CURRENT clock
   * tick. `initialPlanCode`, when given, ALSO seeds a `PppoeService` row for
   * this contract with `profile: initialPlanCode` — fix-wave-2's
   * "PPPoE-profile-at-signup convention", which REPLACES the old
   * same-code→same-code `'modified'`-event hack: in PRODUCTION, an
   * `'activated'` `ContractServiceEvent` carries NO plan info at all, and the
   * plan is NEVER known via a fake same-code event either — it's known
   * because the client's PPPoE service was provisioned with a commercial
   * `profile` at signup (see `contractLifecycle.resolvedPlanCodeAt`'s
   * docblock). Omitting `initialPlanCode` (undefined) leaves the contract
   * WITHOUT a PppoeService row at all — the "sin PPPoE" scenario (still
   * `unpriced`, still VISIBLE via `unpricedContractsActive`).
   */
  async function activate(contractId: string, clientId: string, grClienteId: string, initialPlanCode?: string): Promise<void> {
    eventRepo.setContractClient(contractId, clientId, clientId);
    linkClient(clientId, grClienteId);
    await eventRepo.record({ contractId, serviceCatalogId: internet.id, eventType: 'activated', actorId: null, actorName: 'sistema' });
    if (initialPlanCode) {
      await pppoeRepo.upsertByUsername({
        username: `pppoe-${contractId}`,
        password: 'x',
        profile: initialPlanCode,
        nasId: null,
        contractId,
        status: 'enabled',
      });
    }
  }

  /**
   * Records a real plan-change event AND mirrors `ChangePppoePlanService`'s
   * production behavior of updating `PppoeService.profile` to `newPlan` in
   * the SAME operation (fix-wave-2) — `resolvedPlanCodeAt` anchors on the
   * CURRENT profile, so every fixture that calls `modify()` keeps it
   * truthfully in sync without per-test plumbing.
   */
  async function modify(contractId: string, oldPlan: string, newPlan: string): Promise<void> {
    await eventRepo.record({ contractId, serviceCatalogId: internet.id, eventType: 'modified', oldPlan, newPlan, actorId: null, actorName: 'sistema' });
    await pppoeRepo.upsertByUsername({
      username: `pppoe-${contractId}`,
      password: 'x',
      profile: newPlan,
      nasId: null,
      contractId,
      status: 'enabled',
    });
  }

  async function deactivate(contractId: string): Promise<void> {
    await eventRepo.record({ contractId, serviceCatalogId: internet.id, eventType: 'deactivated', actorId: null, actorName: 'sistema' });
  }
  async function reactivate(contractId: string): Promise<void> {
    await eventRepo.record({ contractId, serviceCatalogId: internet.id, eventType: 'reactivated', actorId: null, actorName: 'sistema' });
  }

  async function definePlan(code: string, downloadKbps: number): Promise<void> {
    await planRepo.upsertByCode({ code, name: code, category: 'internet', downloadKbps, uploadKbps: Math.round(downloadKbps / 5) });
  }
  async function definePrice(code: string, estimatedMonthlyPrice: number): Promise<void> {
    await planPriceRepo.upsert(code, { estimatedMonthlyPrice, updatedByUserId: null });
  }

  return {
    catalogRepo, internet, eventRepo, planRepo, pppoeRepo, clientLinks, receiptRepo, itemRepo, applicationRepo,
    classificationRepo, planPriceRepo, snapshotRepo, useCase, seedCash, linkClient, activate, modify,
    deactivate, reactivate, definePlan, definePrice, clock,
  };
}

describe('BuildFinanceMonthlySnapshot — MRR CONTRATADO bridge basics (rework 2026-07-27)', () => {
  it('one activation with a priced plan: mrrNewArs = that price, mrrFinalArs = same, rest of the bridge is 0', async () => {
    const env = await makeEnv();
    await env.definePlan('IP-30', 30000);
    await env.definePrice('IP-30', 10000);
    env.clock.now = new Date('2026-03-15T15:00:00.000Z');
    await env.activate('c1', 'client-1', 'GR-1', 'IP-30');
    await env.seedCash('GR-1', '2026-03-15T15:00:00.000Z', 10000); // cobranza matches this month exactly

    const snap = await env.useCase.execute('2026-03');

    expect(snap.mrrNewArs).toBe(10000);
    expect(snap.mrrInicialArs).toBe(0);
    expect(snap.mrrUpgradeArs).toBe(0);
    expect(snap.mrrDowngradeArs).toBe(0);
    expect(snap.mrrChurnArs).toBe(0);
    expect(snap.mrrFinalArs).toBe(10000);
    expect(snap.contractsNew).toBe(1);
    expect(snap.contractsActive).toBe(1);
    expect(snap.unpricedContractsActive).toBe(0);
    // COBRANZA is a SEPARATE series (decision LOCK) — same number here only
    // because the fixture happens to match; the bridge never reads it.
    expect(snap.revenueTotalArs).toBe(10000);
    expect(snap.collectionRatePct).toBe(100);
  });

  it('one upgrade with priced plans: the price delta lands in mrrUpgradeArs, kbps-based contractsUpgraded also counts it', async () => {
    const env = await makeEnv();
    await env.definePlan('IP-30', 30000);
    await env.definePlan('IP-100', 100000);
    await env.definePrice('IP-30', 10000);
    await env.definePrice('IP-100', 15000);
    env.clock.now = new Date('2026-01-05T15:00:00.000Z');
    await env.activate('c1', 'client-1', 'GR-1', 'IP-30');
    env.clock.now = new Date('2026-03-20T15:00:00.000Z');
    await env.modify('c1', 'IP-30', 'IP-100');

    const snap = await env.useCase.execute('2026-03');

    expect(snap.mrrInicialArs).toBe(10000);
    expect(snap.mrrUpgradeArs).toBe(5000);
    expect(snap.mrrDowngradeArs).toBe(0);
    expect(snap.mrrNewArs).toBe(0);
    expect(snap.mrrChurnArs).toBe(0);
    expect(snap.mrrFinalArs).toBe(15000);
    expect(snap.contractsUpgraded).toBe(1);
    expect(snap.contractsDowngraded).toBe(0);
  });

  it('one downgrade with priced plans: the delta subtracts into mrrDowngradeArs', async () => {
    const env = await makeEnv();
    await env.definePlan('IP-100', 100000);
    await env.definePlan('IP-30', 30000);
    await env.definePrice('IP-100', 15000);
    await env.definePrice('IP-30', 10000);
    env.clock.now = new Date('2026-01-05T15:00:00.000Z');
    await env.activate('c1', 'client-1', 'GR-1', 'IP-100');
    env.clock.now = new Date('2026-03-20T15:00:00.000Z');
    await env.modify('c1', 'IP-100', 'IP-30');

    const snap = await env.useCase.execute('2026-03');

    expect(snap.mrrInicialArs).toBe(15000);
    expect(snap.mrrDowngradeArs).toBe(5000);
    expect(snap.mrrUpgradeArs).toBe(0);
    expect(snap.mrrFinalArs).toBe(10000);
    expect(snap.contractsDowngraded).toBe(1);
  });

  it('one deactivation of an existing priced contract: its contracted price moves into mrrChurnArs — NO cash lookback needed anymore', async () => {
    const env = await makeEnv();
    await env.definePlan('IP-30', 30000);
    await env.definePrice('IP-30', 10000);
    env.clock.now = new Date('2026-01-05T15:00:00.000Z');
    await env.activate('c1', 'client-1', 'GR-1', 'IP-30');
    env.clock.now = new Date('2026-03-28T15:00:00.000Z');
    await env.deactivate('c1');
    // Deliberately NO cash seeded anywhere (this contract never paid) — the
    // OLD cash-based model needed a 24-month lookback for "last month WITH
    // recorded cash"; the contracted-MRR model doesn't care about payment
    // history at all, only the plan's contracted price.

    const snap = await env.useCase.execute('2026-03');

    expect(snap.mrrChurnArs).toBe(10000);
    expect(snap.mrrInicialArs).toBe(10000);
    expect(snap.mrrFinalArs).toBe(0);
    expect(snap.contractsChurned).toBe(1);
    expect(snap.contractsActive).toBe(0);
    expect(snap.churnContractsPct).toBe(100);
    expect(snap.churnRevenuePct).toBe(100);
  });
});

describe('BuildFinanceMonthlySnapshot — F1/3.16 REWRITE: the bridge invariant over REAL, non-rigged movements', () => {
  /**
   * This is the test the rework was ordered because of. The OLD 3.16 pinned
   * every client's cash to EXACTLY `previous ± delta` by construction — a
   * tautology (change one fixture number and it still "passes" as long as
   * you also change the assertion, because the fixture WAS the assertion).
   *
   * This version builds NINE contracts covering every row of the review's
   * bug table simultaneously — a debtor who pays nothing, a client who
   * regularizes two months at once, alta+baja same month, alta+upgrade same
   * month, upgrade+baja same month, baja+re-alta same month (client never
   * really left), a lateral (same-kbps) price change, and a raw
   * `FinancePlanPrice` bump with NO contract event at all — and verifies the
   * bridge identity holds to the EXACT CENT (not just the ≤1 tolerance the
   * spec allows), while COBRANZA (cash) moves completely independently and
   * is asserted to NOT perturb the bridge at all.
   */
  it('closes EXACTLY (not just within tolerance) over 9 realistic contract movements, while cobranza (cash) moves independently and never touches it', async () => {
    const env = await makeEnv();
    await env.definePlan('IP-30', 30000);
    await env.definePlan('IP-100', 100000);
    await env.definePlan('IP-30-PROMO', 30000); // same kbps as IP-30 — "cambio lateral"
    await env.definePlan('IP-30B', 30000);
    await env.definePrice('IP-30', 10000);
    await env.definePrice('IP-100', 15000);
    await env.definePrice('IP-30-PROMO', 8000);
    await env.definePrice('IP-30B', 10000);

    // ── Pre-existing contracts (active since January, all on IP-30 unless noted) ──
    env.clock.now = new Date('2026-01-05T15:00:00.000Z');
    await env.activate('steady', 'client-steady', 'GR-STEADY', 'IP-30');
    await env.activate('debtor', 'client-debtor', 'GR-DEBTOR', 'IP-30');
    await env.activate('regularizes', 'client-regularizes', 'GR-REGULARIZES', 'IP-30');
    await env.activate('upgradeYBaja', 'client-uyb', 'GR-UYB', 'IP-30');
    await env.activate('bajaYRealta', 'client-byr', 'GR-BYR', 'IP-30');
    await env.activate('lateral', 'client-lateral', 'GR-LATERAL', 'IP-30');
    await env.activate('priceIncrease', 'client-pi', 'GR-PI', 'IP-30B');

    // ── March: the movements ──
    env.clock.now = new Date('2026-03-03T10:00:00.000Z');
    await env.activate('altaYUpgrade', 'client-ayu', 'GR-AYU', 'IP-30'); // brand new

    env.clock.now = new Date('2026-03-05T10:00:00.000Z');
    await env.activate('altaYBaja', 'client-ayb', 'GR-AYB', 'IP-30'); // brand new
    await env.deactivate('bajaYRealta'); // will come back later this month

    env.clock.now = new Date('2026-03-10T10:00:00.000Z');
    await env.modify('upgradeYBaja', 'IP-30', 'IP-100'); // upgrade, THEN churns below
    await env.modify('lateral', 'IP-30', 'IP-30-PROMO'); // same kbps, price drops — lateral

    env.clock.now = new Date('2026-03-12T10:00:00.000Z');
    // Admin raises IP-30B's estimated price mid-month — a config bump, NO
    // ContractServiceEvent at all. Applies uniformly to "priceIncrease"'s
    // start AND end reference within this single execute() call.
    await env.definePrice('IP-30B', 12000);

    env.clock.now = new Date('2026-03-15T10:00:00.000Z');
    await env.modify('altaYUpgrade', 'IP-30', 'IP-100'); // the new contract also upgrades same month

    env.clock.now = new Date('2026-03-20T10:00:00.000Z');
    await env.deactivate('altaYBaja'); // never really existed past this month
    await env.reactivate('bajaYRealta'); // the client never actually left

    env.clock.now = new Date('2026-03-25T10:00:00.000Z');
    await env.deactivate('upgradeYBaja'); // churns AFTER upgrading

    // ── Cobranza (cash) — deliberately INDEPENDENT of every contract event above ──
    await env.seedCash('GR-STEADY', '2026-03-08T15:00:00.000Z', 10000);
    await env.seedCash('GR-DEBTOR', '2026-02-08T15:00:00.000Z', 10000); // debtor paid FEBRUARY, nothing in March
    await env.seedCash('GR-REGULARIZES', '2026-03-08T15:00:00.000Z', 20000); // pays TWO months at once

    const snap = await env.useCase.execute('2026-03');

    // ── The bridge closes EXACTLY (to the cent, not merely ≤1) ──
    const bridgeSum = snap.mrrInicialArs + snap.mrrNewArs + snap.mrrUpgradeArs - snap.mrrDowngradeArs - snap.mrrChurnArs;
    expect(bridgeSum).toBe(snap.mrrFinalArs);
    // fix-wave-3 🟡 4 — bridgeResidualArs makes the (here: zero) gap VISIBLE as its own field.
    expect(snap.bridgeResidualArs).toBe(0);

    // ── Hand-computed expectations, contract by contract ──
    // mrrInicial: steady+debtor+regularizes+upgradeYBaja+bajaYRealta+lateral (10000 x 6) + priceIncrease (12000, CURRENT price, uniformly applied)
    expect(snap.mrrInicialArs).toBe(72000);
    // mrrNew: only altaYUpgrade counts (FINAL price 15000 — subsumes its own mid-month upgrade); altaYBaja contributes 0 (churned before month end)
    expect(snap.mrrNewArs).toBe(15000);
    // mrrUpgrade: only upgradeYBaja's IP-30->IP-100 delta (5000) — altaYUpgrade's upgrade is scoped OUT (already inside mrrNew's final price)
    expect(snap.mrrUpgradeArs).toBe(5000);
    // mrrDowngrade: lateral's price-sign delta (10000->8000 = -2000), even though deriveDirection calls it a LATERAL move (same kbps) — money bucket is price-sign based, not kbps-based
    expect(snap.mrrDowngradeArs).toBe(2000);
    // mrrChurn: only upgradeYBaja (price AT CHURN TIME = post-upgrade 15000); altaYBaja excluded (never in activeAtStart); bajaYRealta excluded (came back — F7)
    expect(snap.mrrChurnArs).toBe(15000);
    // mrrFinal: steady+debtor+regularizes+bajaYRealta (10000 x 4) + lateral (8000) + priceIncrease (12000) + altaYUpgrade (15000)
    expect(snap.mrrFinalArs).toBe(75000);

    // ── F2 — nobody unpriced in this scenario ──
    expect(snap.unpricedContractsActive).toBe(0);
    expect(snap.unpricedPlanChangeEvents).toBe(0);

    // ── F3 — churnContractsPct excludes alta+baja-same-month from BOTH sides ──
    // activeAtStart = 7 (steady/debtor/regularizes/upgradeYBaja/bajaYRealta/lateral/priceIncrease)
    // churnedTrue = {upgradeYBaja} only (bajaYRealta came back, altaYBaja was never in the start base)
    expect(snap.churnContractsPct).toBeCloseTo(14.29, 1); // 1/7
    // ── F4 — churnRevenuePct computed FRESH, no dependency on a stored previous snapshot ──
    expect(snap.churnRevenuePct).toBeCloseTo(20.83, 1); // 15000/72000

    // ── F7 — the RAW activity counters still show the deactivate+reactivate happened (informational)... ──
    expect(snap.contractsChurned).toBe(3); // altaYBaja, upgradeYBaja, bajaYRealta (raw events)
    expect(snap.contractsNew).toBe(3); // altaYBaja, altaYUpgrade, bajaYRealta's reactivation (raw events)
    // ...but the RATE (churnContractsPct, asserted above) correctly excludes bajaYRealta — "the client never really left".

    // ── kbps-based counts stay orthogonal to the money buckets ──
    expect(snap.contractsUpgraded).toBe(2); // altaYUpgrade + upgradeYBaja (kbps-based, ALL contracts)
    expect(snap.contractsDowngraded).toBe(0); // lateral is NOT a kbps downgrade (same kbps) — only a money one

    // ── COBRANZA (cash) is its OWN series — proves the two-numbers decoupling ──
    // debtor paid $0 in March (its cash was in February) yet its CONTRACTED
    // MRR is untouched (still counted in both mrrInicialArs and mrrFinalArs
    // above) — this is EXACTLY what F1 found broken in the cash-based bridge.
    expect(snap.revenueTotalArs).toBe(30000); // steady(10000) + regularizes(20000); debtor's March cash is 0
    expect(snap.collectionRatePct).toBeCloseTo(40, 1); // 30000 / 75000 mrrFinalArs
  });

  it('a plan-change event where the OLD price is unresolvable does NOT get counted as a 3x-inflated upgrade (F2, C1) — it is excluded and flagged', async () => {
    const env = await makeEnv();
    await env.definePlan('IP-30', 30000); // NOTE: deliberately NO definePrice('IP-30', ...) — old plan unpriced
    await env.definePlan('IP-100', 100000);
    await env.definePrice('IP-100', 15000);
    env.clock.now = new Date('2026-01-05T15:00:00.000Z');
    // NO initialPlanCode — this contract's plan is genuinely unresolvable at start (never modified before March).
    // We give it IP-30 via modify (so planCodeAt resolves to IP-30, which has NO price row) instead of leaving it fully null,
    // to reproduce EXACTLY C1's scenario: "IP-30 (sin fila) -> IP-100 (15000)".
    await env.activate('c1', 'client-1', 'GR-1');
    await env.modify('c1', 'IP-30', 'IP-30'); // same-code convention: plan is IP-30, price unresolvable
    env.clock.now = new Date('2026-03-10T15:00:00.000Z');
    await env.modify('c1', 'IP-30', 'IP-100');

    const snap = await env.useCase.execute('2026-03');

    // OLD BUG (F2): `planPricesByCode.get('IP-30') ?? 0` treated the missing
    // row as price 0, so the delta computed as 15000-0=15000 (3x the real
    // ~5000 delta a configured IP-30 price would have produced).
    expect(snap.mrrUpgradeArs).toBe(0); // NEVER a guessed 15000 — excluded, not absorbed as if the missing side were $0
    expect(snap.unpricedPlanChangeEvents).toBe(1); // visible signal instead of a silent/wrong number
    expect(snap.mrrFinalArs).toBe(15000); // the contract's FINAL price (IP-100) is still correctly known
    expect(snap.unpricedContractsActive).toBe(0); // it's PRICED at month-end (IP-100 has a row) — only the TRANSITION was unresolvable
    // fix-wave-3 🟡 4 — this is EXACTLY the case where the bridge does NOT
    // close (the review found this test asserted the symptom but never the
    // identity): bridgeResidualArs must equal mrrFinal - the bridge sum, and
    // must be VISIBLE (non-zero), never silently absorbed as if it were 0.
    const bridgeSum = snap.mrrInicialArs + snap.mrrNewArs + snap.mrrUpgradeArs - snap.mrrDowngradeArs - snap.mrrChurnArs;
    expect(snap.bridgeResidualArs).toBe(snap.mrrFinalArs - bridgeSum);
    expect(snap.bridgeResidualArs).toBe(15000);
  });

  it('a plan-change event where the NEW price is unresolvable is excluded the same way (F2, C2 mirror)', async () => {
    const env = await makeEnv();
    await env.definePlan('IP-100', 100000);
    await env.definePlan('IP-500-EXPERIMENTAL', 500000); // some genuinely unpriced commercial plan (NOT an enforcement code)
    await env.definePrice('IP-100', 15000);
    env.clock.now = new Date('2026-01-05T15:00:00.000Z');
    await env.activate('c1', 'client-1', 'GR-1', 'IP-100');
    env.clock.now = new Date('2026-03-10T15:00:00.000Z');
    await env.modify('c1', 'IP-100', 'IP-500-EXPERIMENTAL');

    const snap = await env.useCase.execute('2026-03');

    expect(snap.mrrDowngradeArs).toBe(0); // never a guessed "downgrade" of the full 15000
    expect(snap.unpricedPlanChangeEvents).toBe(1);
    expect(snap.mrrInicialArs).toBe(15000); // start-of-month price still known (IP-100)
    expect(snap.mrrFinalArs).toBe(0); // end-of-month plan (IP-500-EXPERIMENTAL) has no price — contributes 0
    expect(snap.unpricedContractsActive).toBe(1); // NOW it's the active-at-end population that's unpriced
    expect(snap.unpricedContractsPct).toBe(100);
  });

  it('fix-wave-2: a plan-change event that lands on an ENFORCEMENT code (IP-REDUCCION) is NOT treated as the contract\'s real commercial plan — resolvedPlanCodeAt rewinds to the last known commercial code instead of reporting it unpriced', async () => {
    const env = await makeEnv();
    await env.definePlan('IP-100', 100000);
    await env.definePlan('IP-REDUCCION', 100000); // enforcement-owned code — reserved by the orchestrator, never a real commercial plan
    await env.definePrice('IP-100', 15000);
    // Deliberately NO price for 'IP-REDUCCION' — even if someone tries to price it, it must never be used as the contract's plan.
    env.clock.now = new Date('2026-01-05T15:00:00.000Z');
    await env.activate('c1', 'client-1', 'GR-1', 'IP-100');
    env.clock.now = new Date('2026-03-10T15:00:00.000Z');
    // ANOMALOUS: an admin manually plan-changes to IP-REDUCCION via the normal
    // change-plan flow (bypassing reduce/restore) — the defensive edge case
    // `resolvedPlanCodeAt`'s Phase 2 guards against. In the NORMAL enforcement
    // flow (EnforcePppoeService reduce/block/restore) `PppoeService.profile`
    // is NEVER touched at all, so this scenario cannot happen through that
    // path — this models the manual-mistake path instead.
    await env.modify('c1', 'IP-100', 'IP-REDUCCION');

    const snap = await env.useCase.execute('2026-03');

    // The contract's REAL contracted plan (IP-100) is still what counts — an
    // enforcement code landing in `profile` never zeroes the contract's MRR.
    expect(snap.mrrFinalArs).toBe(15000);
    expect(snap.unpricedContractsActive).toBe(0);
    expect(snap.unpricedContractsPct).toBe(0);
  });

  it('fix-wave-2: a contract cut for mora (enforcedState reduced/blocked) keeps its FULL contracted MRR — enforcement never touches PppoeService.profile', async () => {
    const env = await makeEnv();
    await env.definePlan('IP-30', 30000);
    await env.definePrice('IP-30', 10000);
    env.clock.now = new Date('2026-01-05T15:00:00.000Z');
    await env.activate('c1', 'client-1', 'GR-1', 'IP-30');

    // Simulate EnforcePppoeService's real behavior: ONLY enforcedState changes,
    // `profile` is left completely untouched (see RouterOsEnforcementAdapter /
    // OrchestratorEnforcementAdapter — they patch the router, never the DB profile).
    const service = await env.pppoeRepo.findByUsername('pppoe-c1');
    expect(service).not.toBeNull();
    await env.pppoeRepo.setEnforcedState(service!.id, 'reduced');

    const snap = await env.useCase.execute('2026-03');

    // Cut for mora is NOT the same as unpriced/downgraded — the client still
    // has the IP-30 contract, just capped on the router. Full MRR counts.
    expect(snap.mrrFinalArs).toBe(10000);
    expect(snap.unpricedContractsActive).toBe(0);
  });

  it('fix-wave-2: a contract NEVER modified (no real plan-change event) but WITH a PppoeService profile now resolves and prices correctly — closes the F2 gap', async () => {
    const env = await makeEnv();
    await env.definePlan('IP-30', 30000);
    await env.definePrice('IP-30', 10000);
    env.clock.now = new Date('2026-01-05T15:00:00.000Z');
    // ONLY 'activated' + a PppoeService profile at signup — NO 'modified' event, ever.
    await env.activate('c1', 'client-1', 'GR-1', 'IP-30');

    const snap = await env.useCase.execute('2026-03');

    expect(snap.contractsActive).toBe(1);
    expect(snap.mrrFinalArs).toBe(10000); // resolved from PppoeService.profile alone
    expect(snap.mrrInicialArs).toBe(10000);
    expect(snap.unpricedContractsActive).toBe(0); // THE FIX — this used to be 1 (unconditionally unpriced)
    expect(snap.unpricedContractsPct).toBe(0);
  });

  it('fix-wave-2: a contract with an OLD plan (before a mid-history change) correctly rewinds to the PRE-change plan for an earlier month, and resolves to the NEW plan for a later month', async () => {
    const env = await makeEnv();
    await env.definePlan('IP-30', 30000);
    await env.definePlan('IP-100', 100000);
    await env.definePrice('IP-30', 10000);
    await env.definePrice('IP-100', 15000);
    env.clock.now = new Date('2026-01-05T15:00:00.000Z');
    await env.activate('c1', 'client-1', 'GR-1', 'IP-30');
    env.clock.now = new Date('2026-04-10T15:00:00.000Z');
    await env.modify('c1', 'IP-30', 'IP-100');

    // BEFORE the change: February must resolve to the OLD plan (IP-30), not
    // the current profile (IP-100) — the rewind is what makes this correct.
    const febSnap = await env.useCase.execute('2026-02');
    expect(febSnap.mrrFinalArs).toBe(10000);
    expect(febSnap.unpricedContractsActive).toBe(0);

    // AFTER the change: May resolves to the NEW plan (IP-100).
    const maySnap = await env.useCase.execute('2026-05');
    expect(maySnap.mrrFinalArs).toBe(15000);
    expect(maySnap.unpricedContractsActive).toBe(0);
  });

  it('a contract with NO PppoeService at all has NO resolvable price — visible via unpricedContractsActive, never a silent zero MRR', async () => {
    const env = await makeEnv();
    const env2 = env; // no plans/prices defined for this contract's (nonexistent) plan at all
    env2.clock.now = new Date('2026-03-05T15:00:00.000Z');
    await env2.activate('c1', 'client-1', 'GR-1'); // NO initialPlanCode — no PppoeService row created for c1 at all
    await env2.seedCash('GR-1', '2026-03-10T15:00:00.000Z', 8000); // it DOES pay — cobranza is unaffected by contracted-price resolvability

    const snap = await env2.useCase.execute('2026-03');

    expect(snap.contractsActive).toBe(1);
    expect(snap.mrrFinalArs).toBe(0); // NOT a silent lie — flagged below
    expect(snap.unpricedContractsActive).toBe(1);
    expect(snap.unpricedContractsPct).toBe(100);
    expect(snap.revenueTotalArs).toBe(8000); // cobranza (cash) is completely independent of contracted-price resolvability
  });
});

describe('BuildFinanceMonthlySnapshot — fix-wave-3 🔴 1: the MONEY loop must exclude enforcement-plan events too (the COUNTS loop already did, via deriveDirection)', () => {
  /**
   * Re-review with measured arithmetic (fix-wave-3): the COUNTS path
   * (`contractsUpgraded`/`contractsDowngraded`, via `deriveDirection`) and
   * `resolvedPlanCodeAt` (mrrInicial/mrrFinal) both already skip
   * `IP-REDUCCION`/`IP-BAJA` — but the MONEY loop (`mrrUpgradeArs`/
   * `mrrDowngradeArs`) read `e.oldPlan`/`e.newPlan` RAW, with no
   * `isEnforcementPlan` guard. Reachable from the UI: `IP-REDUCCION`/
   * `IP-BAJA` are ordinary rows in the `Plan` catalog, `GetFinancePlanPrices`
   * lists them, and `UpdateFinancePlanPrice` lets an operator price them —
   * nothing stops a manual plan-change (bypassing reduce/restore) landing on
   * one of these codes while it HAS a price loaded.
   */
  it('IP-100(15000) manually changed to IP-REDUCCION (priced 5000): measured OLD bug was mrrDowngradeArs=10000/gap=-10000 — must be 0, excluded and counted', async () => {
    const env = await makeEnv();
    await env.definePlan('IP-100', 100000);
    await env.definePlan('IP-REDUCCION', 100000);
    await env.definePrice('IP-100', 15000);
    await env.definePrice('IP-REDUCCION', 5000); // ANOMALOUS but possible: an operator priced the enforcement code
    env.clock.now = new Date('2026-01-05T15:00:00.000Z');
    await env.activate('c1', 'client-1', 'GR-1', 'IP-100');
    env.clock.now = new Date('2026-03-10T15:00:00.000Z');
    await env.modify('c1', 'IP-100', 'IP-REDUCCION');

    const snap = await env.useCase.execute('2026-03');

    expect(snap.mrrDowngradeArs).toBe(0); // OLD BUG: 10000 (5000-15000 treated as a real price-sign downgrade)
    expect(snap.mrrUpgradeArs).toBe(0);
    expect(snap.enforcementPlanChangeEventsExcluded).toBe(1); // never silent
    expect(snap.mrrInicialArs).toBe(15000);
    expect(snap.mrrFinalArs).toBe(15000); // resolvedPlanCodeAt rewinds past IP-REDUCCION to the real commercial plan
    const bridgeSum = snap.mrrInicialArs + snap.mrrNewArs + snap.mrrUpgradeArs - snap.mrrDowngradeArs - snap.mrrChurnArs;
    expect(bridgeSum).toBe(snap.mrrFinalArs); // OLD BUG: gap of -10000
  });

  it('IP-100(15000) manually changed to IP-BAJA (priced 0): measured OLD bug was mrrDowngradeArs=15000/gap=-15000 (100% of the base) — must be 0', async () => {
    const env = await makeEnv();
    await env.definePlan('IP-100', 100000);
    await env.definePlan('IP-BAJA', 100000);
    await env.definePrice('IP-100', 15000);
    await env.definePrice('IP-BAJA', 0);
    env.clock.now = new Date('2026-01-05T15:00:00.000Z');
    await env.activate('c1', 'client-1', 'GR-1', 'IP-100');
    env.clock.now = new Date('2026-03-10T15:00:00.000Z');
    await env.modify('c1', 'IP-100', 'IP-BAJA');

    const snap = await env.useCase.execute('2026-03');

    expect(snap.mrrDowngradeArs).toBe(0); // OLD BUG: 15000 (100% of the contract's base, wiped as a fake downgrade)
    expect(snap.enforcementPlanChangeEventsExcluded).toBe(1);
    expect(snap.mrrFinalArs).toBe(15000);
    const bridgeSum = snap.mrrInicialArs + snap.mrrNewArs + snap.mrrUpgradeArs - snap.mrrDowngradeArs - snap.mrrChurnArs;
    expect(bridgeSum).toBe(snap.mrrFinalArs);
  });

  it('IP-100→IP-BAJA AND the contract churns the SAME month: measured OLD bug double-counted (down 15000 AND churn 15000) — the money loop must contribute 0, churn alone carries the real price', async () => {
    const env = await makeEnv();
    await env.definePlan('IP-100', 100000);
    await env.definePlan('IP-BAJA', 100000);
    await env.definePrice('IP-100', 15000);
    await env.definePrice('IP-BAJA', 0);
    env.clock.now = new Date('2026-01-05T15:00:00.000Z');
    await env.activate('c1', 'client-1', 'GR-1', 'IP-100');
    env.clock.now = new Date('2026-03-10T15:00:00.000Z');
    await env.modify('c1', 'IP-100', 'IP-BAJA');
    env.clock.now = new Date('2026-03-20T15:00:00.000Z');
    await env.deactivate('c1');

    const snap = await env.useCase.execute('2026-03');

    expect(snap.mrrDowngradeArs).toBe(0); // OLD BUG: 15000 (double-counted alongside churn)
    expect(snap.mrrChurnArs).toBe(15000); // the REAL price at churn time (resolvedPlanCodeAt rewinds past IP-BAJA)
    expect(snap.enforcementPlanChangeEventsExcluded).toBe(1);
    expect(snap.mrrFinalArs).toBe(0); // deactivated — not active at month end
    const bridgeSum = snap.mrrInicialArs + snap.mrrNewArs + snap.mrrUpgradeArs - snap.mrrDowngradeArs - snap.mrrChurnArs;
    expect(bridgeSum).toBe(snap.mrrFinalArs); // OLD BUG: 15000 - 15000(fake down) - 15000(churn) = -15000 ≠ 0
  });

  it('N enforcement-code reductions in the same month (scaled-down from the measured 200): each contributes 0 to mrrDowngradeArs/mrrUpgradeArs, all counted', async () => {
    const env = await makeEnv();
    await env.definePlan('IP-100', 100000);
    await env.definePlan('IP-REDUCCION', 100000);
    await env.definePrice('IP-100', 15000);
    await env.definePrice('IP-REDUCCION', 5000);
    env.clock.now = new Date('2026-01-05T15:00:00.000Z');
    const ids = ['c1', 'c2', 'c3'];
    for (const id of ids) await env.activate(id, `client-${id}`, `GR-${id}`, 'IP-100');
    env.clock.now = new Date('2026-03-10T15:00:00.000Z');
    for (const id of ids) await env.modify(id, 'IP-100', 'IP-REDUCCION');

    const snap = await env.useCase.execute('2026-03');

    // OLD BUG (scaled to 200 in the review): mrrDowngradeArs would be 3 * 10000 = 30000 here.
    expect(snap.mrrDowngradeArs).toBe(0);
    expect(snap.enforcementPlanChangeEventsExcluded).toBe(3);
    expect(snap.mrrFinalArs).toBe(45000); // 3 x 15000, real commercial plan
  });
});

describe('BuildFinanceMonthlySnapshot — fix-wave-3 🔴 2: collectionRatePct must divide by the SAME (internet-only) population as the numerator', () => {
  /**
   * Measured bug: numerator (`revenueTotalArs`, Capa A) is cash from the
   * WHOLE company (includes TV-only clients — decision LOCK), while the
   * denominator (`mrrFinalArs`) is MRR contracted for INTERNET ONLY. Mixing
   * the two populations let `collectionRatePct` exceed 100% for a client
   * base that paid EXACTLY what it owed. Fix: numerator becomes
   * `revenueInternetAttributedArs` (Capa B, already computed for
   * `arpuArs`/`attributionPct`) — same population as `mrrFinalArs`.
   */
  it('1 internet contract (MRR 10000) pays exactly 10000 + 1 TV-only client pays 40000: measured OLD bug was 500%, must be 100%', async () => {
    const env = await makeEnv();
    await env.definePlan('IP-30', 30000);
    await env.definePrice('IP-30', 10000);
    env.clock.now = new Date('2026-03-05T15:00:00.000Z');
    await env.activate('c1', 'client-1', 'GR-1', 'IP-30');
    await env.seedCash('GR-1', '2026-03-10T15:00:00.000Z', 10000);
    // TV-only client — no internet contract at all, but pays real cash counted in revenueTotalArs (Capa A, company-wide, decision LOCK).
    await env.seedCash('GR-TV-ONLY', '2026-03-10T15:00:00.000Z', 40000);

    const snap = await env.useCase.execute('2026-03');

    expect(snap.revenueTotalArs).toBe(50000); // Capa A, unscoped — unchanged by this fix
    expect(snap.mrrFinalArs).toBe(10000);
    expect(snap.collectionRatePct).toBe(100); // OLD BUG: 500 (50000 / 10000)
  });

  it('a debtor who pays nothing keeps collectionRatePct honestly below 100, unaffected by another internet contract\'s cash', async () => {
    const env = await makeEnv();
    await env.definePlan('IP-30', 30000);
    await env.definePrice('IP-30', 10000);
    env.clock.now = new Date('2026-01-05T15:00:00.000Z');
    await env.activate('payer', 'client-payer', 'GR-PAYER', 'IP-30');
    await env.activate('debtor', 'client-debtor', 'GR-DEBTOR', 'IP-30');
    env.clock.now = new Date('2026-03-10T15:00:00.000Z');
    await env.seedCash('GR-PAYER', '2026-03-10T15:00:00.000Z', 10000);
    // debtor pays nothing in March.

    const snap = await env.useCase.execute('2026-03');

    expect(snap.mrrFinalArs).toBe(20000);
    expect(snap.collectionRatePct).toBe(50); // 10000 (internet-attributed) / 20000 — same population both sides
  });
});

describe('BuildFinanceMonthlySnapshot — fix-wave-3 🟡 4: bridgeResidualArs makes an unclosed bridge VISIBLE', () => {
  it('is exactly 0 in the healthy 9-movement scenario (bridge closes to the cent)', async () => {
    const env = await makeEnv();
    await env.definePlan('IP-30', 30000);
    await env.definePrice('IP-30', 10000);
    env.clock.now = new Date('2026-01-05T15:00:00.000Z');
    await env.activate('steady', 'client-steady', 'GR-STEADY', 'IP-30');

    const snap = await env.useCase.execute('2026-01');

    expect(snap.bridgeResidualArs).toBe(0);
  });

  // The "gap made visible" case (unresolvable old price on a plan-change
  // event) is asserted directly inside the pre-existing F2/C1 test above
  // ("a plan-change event where the OLD price is unresolvable...", ~line
  // 357) — the review's exact finding was that THAT test montaba el caso
  // sin precio pero nunca verificaba la identidad del bridge; the fix lives
  // there, not duplicated here.
});

describe('BuildFinanceMonthlySnapshot — F5: ARPU divides the RIGHT population (internet clients only)', () => {
  it('a non-internet GR client\'s cash does NOT inflate ARPU (N1: 1 internet contract pays 10000, 1 non-internet client pays 40000)', async () => {
    const env = await makeEnv();
    await env.definePlan('IP-30', 30000);
    await env.definePrice('IP-30', 10000);
    env.clock.now = new Date('2026-03-05T15:00:00.000Z');
    await env.activate('c1', 'client-1', 'GR-1', 'IP-30');
    await env.seedCash('GR-1', '2026-03-10T15:00:00.000Z', 10000);
    // A GR client with NO internet contract at all — its cash still counts
    // toward revenueTotalArs (Capa A, company-wide) but must NOT touch ARPU.
    await env.seedCash('GR-NO-INTERNET', '2026-03-10T15:00:00.000Z', 40000);

    const snap = await env.useCase.execute('2026-03');

    expect(snap.revenueTotalArs).toBe(50000); // Capa A — the whole company, unscoped
    expect(snap.arpuArs).toBe(10000); // NOT 50000 — scoped to the 1 internet contract's own cash
  });
});

describe('BuildFinanceMonthlySnapshot — F6: attributionPct measures the RIGHT population (includes churned-this-month cash)', () => {
  it('a contract that collects cash and churns mid-month is NOT invisible to attributionPct (H2)', async () => {
    const env = await makeEnv();
    await env.definePlan('IP-30', 30000);
    await env.definePrice('IP-30', 10000);
    env.clock.now = new Date('2026-01-05T15:00:00.000Z');
    await env.activate('churns', 'client-churns', 'GR-CHURNS', 'IP-30');
    await env.activate('survives', 'client-survives', 'GR-SURVIVES', 'IP-30');
    env.clock.now = new Date('2026-03-10T15:00:00.000Z');
    await env.seedCash('GR-CHURNS', '2026-03-10T15:00:00.000Z', 5000); // pays, THEN leaves
    await env.seedCash('GR-SURVIVES', '2026-03-10T15:00:00.000Z', 5000);
    env.clock.now = new Date('2026-03-20T15:00:00.000Z');
    await env.deactivate('churns');

    const snap = await env.useCase.execute('2026-03');

    // OLD BUG: the denominator only summed contracts STILL active at
    // month-end (5000, "survives" only) — "churns"'s 5000 was invisible to
    // the ratio entirely, even though it's real cash collected this month.
    expect(snap.attributionPct).toBe(100); // both exact-confidence; the number itself doesn't change here, but now honestly considers BOTH 5000s
    expect(snap.revenueAttributableArs).toBe(10000); // proof the denominator now spans BOTH contracts, not just the survivor
  });

  it('mixed exact+estimated population still computes the correct pct (regression: single-contract vs shared-client split)', async () => {
    const env = await makeEnv();
    env.clock.now = new Date('2026-03-05T15:00:00.000Z');
    await env.activate('exact1', 'client-exact', 'GR-EXACT');
    env.eventRepo.setContractClient('shared-a', 'client-shared', 'Shared');
    env.eventRepo.setContractClient('shared-b', 'client-shared', 'Shared');
    env.linkClient('client-shared', 'GR-SHARED');
    await env.eventRepo.record({ contractId: 'shared-a', serviceCatalogId: env.internet.id, eventType: 'activated', actorId: null, actorName: 'sistema' });
    await env.eventRepo.record({ contractId: 'shared-b', serviceCatalogId: env.internet.id, eventType: 'activated', actorId: null, actorName: 'sistema' });
    await env.seedCash('GR-EXACT', '2026-03-10T15:00:00.000Z', 4000);
    await env.seedCash('GR-SHARED', '2026-03-10T15:00:00.000Z', 6000);

    const snap = await env.useCase.execute('2026-03');

    expect(snap.revenueAttributableArs).toBe(4000);
    expect(snap.attributionPct).toBe(40);
  });
});

describe('BuildFinanceMonthlySnapshot — F7: a same-month baja+re-alta does not count as churn (the client never really left)', () => {
  it('E1: deactivated then reactivated within the same month excludes it from churnContractsPct/mrrChurnArs, unlike the raw activity counters', async () => {
    const env = await makeEnv();
    await env.definePlan('IP-30', 30000);
    await env.definePrice('IP-30', 10000);
    env.clock.now = new Date('2026-01-05T15:00:00.000Z');
    await env.activate('c1', 'client-1', 'GR-1', 'IP-30');
    env.clock.now = new Date('2026-03-05T15:00:00.000Z');
    await env.deactivate('c1');
    env.clock.now = new Date('2026-03-20T15:00:00.000Z');
    await env.reactivate('c1');

    const snap = await env.useCase.execute('2026-03');

    expect(snap.contractsActive).toBe(1); // active at month end
    expect(snap.churnContractsPct).toBe(0); // OLD BUG: this showed 100% (contractsNew:1, contractsChurned:1)
    expect(snap.mrrChurnArs).toBe(0);
    expect(snap.mrrInicialArs).toBe(10000);
    expect(snap.mrrFinalArs).toBe(10000); // unchanged — the client never actually left
    // The RAW activity counters still show what happened (informational, unchanged semantics):
    expect(snap.contractsChurned).toBe(1);
    expect(snap.contractsNew).toBe(1);
  });
});

describe('BuildFinanceMonthlySnapshot — F3: alta+baja within the same month cannot push churnContractsPct over 100%', () => {
  it('F1: 2 stable actives (neither churns) + 3 alta-y-baja within the month must NOT report churnContractsPct > 100', async () => {
    const env = await makeEnv();
    await env.definePlan('IP-30', 30000);
    await env.definePrice('IP-30', 10000);
    env.clock.now = new Date('2026-01-05T15:00:00.000Z');
    await env.activate('stable1', 'client-s1', 'GR-S1', 'IP-30');
    await env.activate('stable2', 'client-s2', 'GR-S2', 'IP-30');

    env.clock.now = new Date('2026-03-05T15:00:00.000Z');
    for (const id of ['transient1', 'transient2', 'transient3']) {
      await env.activate(id, `client-${id}`, `GR-${id}`, 'IP-30');
    }
    env.clock.now = new Date('2026-03-20T15:00:00.000Z');
    for (const id of ['transient1', 'transient2', 'transient3']) {
      await env.deactivate(id);
    }

    const snap = await env.useCase.execute('2026-03');

    // OLD BUG: numerator = 3 (all deactivations this month), denominator = 2
    // (active at start, unmoved) => 150%. The stable base never moved.
    expect(snap.churnContractsPct).toBe(0);
    expect(snap.churnContractsPct).toBeLessThanOrEqual(100);
  });
});

describe('BuildFinanceMonthlySnapshot — F4: churnRevenuePct is computed fresh, never silently zeroed by a missing prior snapshot', () => {
  it('O1: no snapshot was ever computed for the previous month, yet a churn this month still yields a correct non-zero rate', async () => {
    const env = await makeEnv();
    await env.definePlan('IP-30', 30000);
    await env.definePrice('IP-30', 10000);
    await env.definePlan('IP-100', 100000);
    await env.definePrice('IP-100', 10000);
    env.clock.now = new Date('2026-01-05T15:00:00.000Z');
    await env.activate('churned', 'client-churned', 'GR-CHURNED', 'IP-30');
    await env.activate('survivor', 'client-survivor', 'GR-SURVIVOR', 'IP-100');
    // Deliberately NEVER call execute('2026-02') — no stored snapshot exists for February.
    env.clock.now = new Date('2026-03-05T15:00:00.000Z');
    await env.deactivate('churned');

    const snap = await env.useCase.execute('2026-03');

    // OLD BUG: mrrInicialArs came from `previousSnapshot?.mrrFinalArs ?? 0`
    // — with no Feb snapshot, that was 0, so churnRevenuePct computed as
    // 0/0 => reported as a lying "0" (looks like "no churn").
    expect(snap.mrrInicialArs).toBe(20000); // computed FRESH from event history, independent of any stored snapshot
    expect(snap.mrrChurnArs).toBe(10000);
    expect(snap.churnRevenuePct).toBe(50);
  });

  it('churnRevenuePct is null (not 0) when there were zero contracts active at the start of the month — "no base", not "no churn"', async () => {
    const env = await makeEnv();
    env.clock.now = new Date('2026-03-05T15:00:00.000Z');
    // Nothing existed before March — no contracts, no events prior to this month.

    const snap = await env.useCase.execute('2026-03');

    expect(snap.churnRevenuePct).toBeNull();
  });
});

describe('BuildFinanceMonthlySnapshot — persistence, orphan guard, F9 unclassifiedAmountArs date cut', () => {
  it('persists the snapshot idempotently keyed by yearMonth (a re-run overwrites, never duplicates)', async () => {
    const env = await makeEnv();
    await env.definePlan('IP-30', 30000);
    await env.definePrice('IP-30', 10000);
    env.clock.now = new Date('2026-03-05T15:00:00.000Z');
    await env.activate('c1', 'client-1', 'GR-1', 'IP-30');
    await env.seedCash('GR-1', '2026-03-10T15:00:00.000Z', 5000);

    await env.useCase.execute('2026-03');
    await env.useCase.execute('2026-03');
    const stored = await env.snapshotRepo.listRange('2026-01', '2026-12');
    expect(stored).toHaveLength(1);
    expect(stored[0].mrrFinalArs).toBe(10000);
    expect(stored[0].revenueTotalArs).toBe(5000);
  });

  it('an unclassified application with appliedDate: null is STILL tallied into unclassifiedAmountArs (F9 — cut by receipt.fechaRecibo, not the nullable appliedDate)', async () => {
    const env = await makeEnv();
    env.clock.now = new Date('2026-03-05T15:00:00.000Z');
    await env.activate('c1', 'client-1', 'GR-1');
    await env.seedCash('GR-1', '2026-03-10T15:00:00.000Z', 5000);
    env.classificationRepo.seed('FB', 'revenue');
    await env.applicationRepo.upsertBatch([
      // appliedDate: null reproduces P1 exactly — the receipt itself (via
      // seedCash above) IS dated in March, but this application's OWN
      // appliedDate is missing on the wire.
      { grApplicationId: 'app-1', receiptId: 'receipt-1', grInvoiceId: 'XZ-1-1', grType: 'XZ', amount: 900, appliedDate: null },
    ]);

    const snap = await env.useCase.execute('2026-03');

    // OLD BUG: appliedDate: null made this application invisible to
    // listByMonth entirely — unclassifiedAmountArs silently reported 0.
    expect(snap.unclassifiedAmountArs).toBe(900);
    expect(snap.revenueTotalArs).toBe(5000); // cash (items), unaffected by application classification
  });

  it('a client whose grClienteId never resolves locally is counted but never aborts the month computation', async () => {
    const env = await makeEnv();
    await env.definePlan('IP-30', 30000);
    await env.definePrice('IP-30', 10000);
    env.clock.now = new Date('2026-03-05T15:00:00.000Z');
    env.eventRepo.setContractClient('orphan-contract', 'client-orphan', 'Orphan');
    await env.eventRepo.record({ contractId: 'orphan-contract', serviceCatalogId: env.internet.id, eventType: 'activated', actorId: null, actorName: 'sistema' });
    await env.activate('c1', 'client-1', 'GR-1', 'IP-30');
    await env.seedCash('GR-1', '2026-03-10T15:00:00.000Z', 5000);

    const snap = await env.useCase.execute('2026-03');

    expect(snap.contractsActive).toBe(2);
    // mrrFinalArs is now CONTRACTED, not cash — the orphan contributes 0
    // because it was never given an initialPlanCode (unpriced), same as c1
    // would if it too had no plan; here c1 IS priced.
    expect(snap.mrrFinalArs).toBe(10000);
    expect(snap.unpricedContractsActive).toBe(1); // the orphan contract — no plan, no price, correctly flagged (F2), never crashed
  });
});

// ── gr-receipt-annulment (design.md Decision 6, `finance-dashboard-annulment-filter`
// spec.md scenario 22/24 at the aggregate level, D5) — closes deuda #7: an
// anulado receipt's items/applications must NOT reach revenueTotalArs or
// unclassifiedAmountArs. Fixture has AT LEAST 2 receipts with DISTINCT
// amounts — a single-element fixture would let the mutant "the filter
// doesn't filter" survive (the lesson behind "fixtures degenerados ocultan
// invariantes").
describe('gr-receipt-annulment: an anulado receipt is excluded from the monthly snapshot (D5)', () => {
  it('a voided receipt\'s items are excluded from revenueTotalArs, and its applications from unclassifiedAmountArs — the healthy sibling still counts', async () => {
    const env = await makeEnv();
    env.clock.now = new Date('2026-03-05T15:00:00.000Z');
    await env.activate('c1', 'client-1', 'GR-1');

    await env.seedCash('GR-1', '2026-03-10T15:00:00.000Z', 5000); // healthy — becomes receipt-1
    await env.seedCash('GR-1', '2026-03-11T15:00:00.000Z', 8000); // will be voided — becomes receipt-2

    // Void receipt-2 AFTER seeding it — upsert re-writes the SAME row (the
    // exact re-upsert path the reconcile lane's "flip" exercises).
    await env.receiptRepo.upsertBatch([
      { grReceiptId: 'receipt-2', clientGrId: 'GR-1', recaudador: null, fechaRecibo: new Date('2026-03-11T15:00:00.000Z'), fechaConfirmacion: null, anulado: true, observaciones: null },
    ]);

    env.classificationRepo.seed('FB', 'revenue');
    await env.applicationRepo.upsertBatch([
      { grApplicationId: 'app-sano', receiptId: 'receipt-1', grInvoiceId: 'XZ-1-1', grType: 'XZ', amount: 900, appliedDate: null },
      { grApplicationId: 'app-anulado', receiptId: 'receipt-2', grInvoiceId: 'XZ-2-2', grType: 'XZ', amount: 1200, appliedDate: null },
    ]);

    const snap = await env.useCase.execute('2026-03');

    // Cash (items): ONLY the healthy receipt's 5000 — the voided receipt's
    // 8000 must NOT leak through, even though its own item row still exists.
    expect(snap.revenueTotalArs).toBe(5000);
    // unclassifiedAmountArs: ONLY the healthy receipt's 900 application.
    expect(snap.unclassifiedAmountArs).toBe(900);
  });
});
