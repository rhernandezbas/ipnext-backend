import type { ContractServiceEventRepository, ContractServiceEventWithClient } from '@domain/ports/ContractServiceEventRepository';
import type { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import type { PlanRepository } from '@domain/ports/PlanRepository';
import type { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import type { ClientMirrorReadRepository } from '@domain/ports/ClientMirrorReadRepository';
import type { FinanceReceiptItemRepository } from '@domain/ports/FinanceReceiptItemRepository';
import type { FinanceReceiptApplicationRepository } from '@domain/ports/FinanceReceiptApplicationRepository';
import type { FinanceInvoiceTypeClassificationRepository, FinanceInvoiceTypeBucket } from '@domain/ports/FinanceInvoiceTypeClassificationRepository';
import type { FinancePlanPriceRepository } from '@domain/ports/FinancePlanPriceRepository';
import type { FinanceMonthlySnapshot, FinanceMonthlySnapshotRepository } from '@domain/ports/FinanceMonthlySnapshotRepository';
import { deriveDirection } from '@application/use-cases/ListInternetServiceHistory';
import { yearMonthToDateRange, isValidYearMonth } from '@application/use-cases/finance/financeDates';
import {
  attributeCollectedAmountToContracts,
  netCollectedAmountForMonth,
  type AttributedContractShare,
} from '@application/use-cases/finance/financeAttribution';
import { isContractActiveAt, isContractActiveDuring, resolvedPlanCodeAt } from '@application/use-cases/finance/contractLifecycle';
import { isEnforcementPlan } from '@domain/entities/plan';

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Resolution of a contract's contracted price at a point in time — `priced: false` means "unknown", NEVER treated as price 0 (F2). */
interface PriceInfo {
  priced: boolean;
  price: number;
}

/**
 * finance-growth Fase 3 REWORK (2026-07-27, "DOS NÚMEROS, DOS PREGUNTAS" —
 * user LOCK decision, see FinanceMonthlySnapshotRepository.ts's docblock for
 * the full field-by-field contract) — computes and persists the monthly
 * snapshot.
 *
 * ── WHY THE REWORK: the bridge cannot close over cash ──
 *
 * The ORIGINAL Fase 3 bridge decomposed the MONTH-OVER-MONTH CHANGE IN CASH
 * COLLECTED into altas/upgrades/downgrades/bajas. That decomposition is only
 * valid over a base that changes EXCLUSIVELY via those 4 event types — cash
 * doesn't: it moves by mora, pagos adelantados, regularizaciones and
 * inflación, none of which the bridge has a term for. Measured gaps ran into
 * the THOUSANDS on bases of 10-20k (a client who simply doesn't pay this
 * month showed as -100% "churn" with the contract still active). This isn't
 * a bug to patch — it's structural, and no amount of extra bookkeeping terms
 * fixes it, because cash is not decomposable into those 4 buckets.
 *
 * The fix: stop trying to bridge cash. Bridge **MRR CONTRATADO** (Σ precio
 * de plan × contratos activos) instead — a base that, BY DEFINITION, only
 * changes via altas/upgrades/downgrades/bajas, so the bridge closes exactly
 * (modulo the honest "unresolvable price" exception, see below). Cobranza
 * real keeps its own, bridge-free series (`revenueTotalArs`, unchanged
 * cash-collected computation) — the two numbers answer different questions
 * and were never the same thing.
 *
 * ── HOW THE BRIDGE CLOSES BY CONSTRUCTION ──
 *
 * `mrrInicialArs`/`mrrFinalArs` are computed FRESH every run (never chained
 * from a stored previous snapshot — this ALSO fixes F4: a skipped previous
 * month used to silently zero the churn-rate denominator). For a contract
 * priced at both ends of a transition, the telescoping identity holds
 * EXACTLY:
 *  - Existing contract (in `contractsActiveAtStartIds`), no events this
 *    month: contributes P to both mrrInicial and mrrFinal, 0 net.
 *  - Existing contract, upgrades P0→P1 mid-month: mrrInicial has P0,
 *    mrrUpgrade has (P1-P0), mrrFinal has P1. P0 + (P1-P0) = P1. ✓.
 *  - Existing contract, upgrades P0→P1 THEN churns same month: mrrInicial
 *    has P0, mrrUpgrade has (P1-P0), mrrChurn has P1 (price AT time of
 *    churn — i.e. the UPGRADED price, via `planCodeAt(id, monthEnd-1)`,
 *    which walks ALL 'modified' events regardless of active/inactive
 *    state). P0 + (P1-P0) - P1 = 0 = mrrFinal (not active at end). ✓.
 *  - New contract this month, still active at month-end: mrrNew uses the
 *    FINAL known price (`monthEnd-1`), which already subsumes any
 *    mid-month upgrade/downgrade — so 'modified' events are scoped to
 *    `contractsActiveAtStartIds` ONLY (this one excludes it, avoiding
 *    double-counting the same delta in both mrrNew and mrrUpgrade/mrrDowngrade).
 *  - Alta+baja same month (never in activeAtStart NOR activeAtEnd): scoping
 *    'modified' events to activeAtStart ALSO excludes this transient
 *    contract's own modify events, so it contributes 0 everywhere it's not
 *    anchored — 0 net, matching its 0 contribution to mrrInicial/mrrFinal.
 *  - Baja+re-alta same month (in BOTH activeAtStart AND activeAtEnd,
 *    "churn" never really happened): `churnedTrueIds` requires NOT being
 *    active at month-end, so this contract is excluded from mrrChurnArs
 *    entirely (F7) — its price at start equals its price at end (no plan
 *    change), 0 net, correctly reflecting "the client never actually left".
 *
 * ── PLAN RESOLUTION (fix-wave-2 — F2's gap CLOSED): `PppoeService.profile` ──
 *
 * A contract's plan code is resolved from `PppoeService.profile` (the
 * contract's CURRENT commercial plan — batch-fetched via
 * `PppoeServiceRepository.findCurrentProfilesByContractIds`) rewound through
 * the contract's OWN `ContractServiceEvent` 'modified' history to the
 * requested point in time (`contractLifecycle.resolvedPlanCodeAt` — see its
 * docblock for the full algorithm and WHY `profile`, not `Contract.plan`, is
 * the source: `ChangePppoePlanService` writes `profile` AND the `'modified'`
 * event's `oldPlan`/`newPlan` from the exact same value).
 *
 * This CLOSES the original F2 gap: **'activated' events carry NO plan info
 * in this codebase**, so the OLD approach (deriving the plan EXCLUSIVELY
 * from 'modified' events) left `planCode: null` for a contract's ENTIRE
 * lifetime whenever it never had a real plan-change event — MOST stable,
 * never-upgraded contracts in a fresh production dataset. Anchoring on
 * `profile` instead gives full coverage for every contract with a resolvable
 * PPPoE service.
 *
 * `unpricedContractsActive`/`unpricedContractsPct` are NOT eliminated by
 * this fix — they now mean something narrower and more honest: a contract
 * with NO resolvable PPPoE service at all (never had one, only has
 * `'terminated'` rows, or was disassociated via `clearContractId`/
 * `onDelete: SetNull` — see `pickCurrentPppoeService`), OR whose resolved
 * plan code has no `FinancePlanPrice` row. A contract cut for mora
 * (`enforcedState: 'reduced'/'blocked'`) is NEVER counted here purely for
 * being cut — `profile` is never touched by enforcement (see
 * `resolvedPlanCodeAt`'s docblock), so it still resolves to its real
 * commercial plan and prices normally.
 *
 * A 'modified' event where EITHER side's price is unresolvable contributes
 * 0 to mrrUpgradeArs/mrrDowngradeArs (never treats the missing side as
 * price 0 — that was F2's literal 3x-inflation bug) and increments
 * `unpricedPlanChangeEvents` — visible, never folded into a wrong number.
 *
 * ── Scope decisions NOT spelled out verbatim in design.md ──
 *
 * 1. Scoped to the INTERNET `ServiceCatalog` (same catalog
 *    `ListInternetServiceHistory` uses).
 *
 * 2. Does NOT depend on `ContractRepository` — plan code comes from
 *    `PppoeServiceRepository` (current profile) rewound via
 *    `ContractServiceEvent` history (see above). Never `Contract.plan`, a
 *    different, GR-owned, free-text vocabulary (`'300MB'`, `'20/5MB GRAL'`,
 *    …) that doesn't match the `Plan` catalog's codes at all.
 *
 * 3. `contractsUpgraded`/`contractsDowngraded` (COUNTS) stay KBPS-based
 *    (`deriveDirection`, same criterion as `ListInternetServiceHistory`,
 *    spec.md "Contract-modification listing reuses..."), computed over ALL
 *    contracts regardless of when they started — a pure activity count,
 *    unrelated to money. `mrrUpgradeArs`/`mrrDowngradeArs` (MONEY) are
 *    PRICE-SIGN based instead (positive delta → upgrade, negative →
 *    downgrade), independent of kbps direction, and scoped to
 *    `contractsActiveAtStartIds` (see "how the bridge closes" above). This
 *    is DELIBERATE: a "cambio lateral" (same kbps, different price) has NO
 *    kbps-based direction (`deriveDirection` returns `null`) but DOES move
 *    money — under the old kbps-gated bridge that money vanished from every
 *    bucket while still showing up in `mrrFinalArs`, breaking the identity.
 *    Money buckets and kbps-count buckets are now two orthogonal,
 *    independently-correct axes, both honestly labeled.
 *
 * 4. `unclassifiedAmountArs` is computed from `FinanceReceiptApplication`
 *    (Capa A, `netCollectedAmountForMonth`) — a reconciliation SIGNAL
 *    completely separate from `revenueTotalArs` (cash-based,
 *    `FinanceReceiptItem`). Fixed (F9) to cut by `receipt.fechaRecibo`
 *    (via the repository), not the application's own nullable `appliedDate`.
 */
export class BuildFinanceMonthlySnapshot {
  constructor(
    private readonly eventRepo: ContractServiceEventRepository,
    private readonly catalogRepo: ServiceCatalogRepository,
    private readonly planRepo: PlanRepository,
    private readonly pppoeRepo: PppoeServiceRepository,
    private readonly clientLinks: ClientMirrorReadRepository,
    private readonly itemRepo: FinanceReceiptItemRepository,
    private readonly applicationRepo: FinanceReceiptApplicationRepository,
    private readonly classificationRepo: FinanceInvoiceTypeClassificationRepository,
    private readonly planPriceRepo: FinancePlanPriceRepository,
    private readonly snapshotRepo: FinanceMonthlySnapshotRepository,
  ) {}

  async execute(yearMonth: string): Promise<FinanceMonthlySnapshot> {
    if (!isValidYearMonth(yearMonth)) {
      throw new Error(`BuildFinanceMonthlySnapshot: "${yearMonth}" no es un YYYY-MM válido`);
    }

    const internet = await this.catalogRepo.getByName('INTERNET');
    if (!internet) {
      throw new Error('BuildFinanceMonthlySnapshot: ServiceCatalog "INTERNET" no existe — catálogo mal seedeado');
    }

    const [plans, planPriceRows] = await Promise.all([this.planRepo.list(), this.planPriceRepo.list()]);
    const kbpsByCode = new Map(plans.map((p) => [p.code, p.downloadKbps]));
    const planPricesByCode = new Map(planPriceRows.map((p) => [p.planCode, p.estimatedMonthlyPrice]));

    const allEventsDesc = await this.eventRepo.list({ serviceCatalogId: internet.id });
    const eventsAsc = [...allEventsDesc].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));

    const eventsByContract = new Map<string, ContractServiceEventWithClient[]>();
    for (const e of eventsAsc) {
      const list = eventsByContract.get(e.contractId);
      if (list) list.push(e);
      else eventsByContract.set(e.contractId, [e]);
    }
    const allContractIds = [...eventsByContract.keys()];

    // fix-wave-2 — ONE batch lookup for every contract's CURRENT PppoeService
    // profile (never N+1), the anchor `resolvedPlanCodeAt` rewinds from.
    const currentProfileByContract = await this.pppoeRepo.findCurrentProfilesByContractIds(allContractIds);

    const isActiveAt = (contractId: string, at: Date): boolean => isContractActiveAt(eventsByContract.get(contractId) ?? [], at);
    const planCodeAt = (contractId: string, at: Date): string | null =>
      resolvedPlanCodeAt(eventsByContract.get(contractId) ?? [], at, currentProfileByContract.get(contractId) ?? null);
    const activeDuring = (contractId: string, start: Date, endExclusive: Date): boolean =>
      isContractActiveDuring(eventsByContract.get(contractId) ?? [], start, endExclusive);

    /** F2 — a contract's contracted price at `at`: `priced: false` (never price 0) when the plan code itself is unresolvable OR the resolved code has no FinancePlanPrice row. */
    const priceInfoAt = (contractId: string, at: Date): PriceInfo => {
      const code = planCodeAt(contractId, at);
      if (code === null) return { priced: false, price: 0 };
      const price = planPricesByCode.get(code);
      if (price === undefined) return { priced: false, price: 0 };
      return { priced: true, price };
    };

    const { start: monthStart, endExclusive: monthEnd } = yearMonthToDateRange(yearMonth);
    const monthStartInstant = new Date(monthStart.getTime() - 1);
    const monthEndInstant = new Date(monthEnd.getTime() - 1);

    const contractsActiveAtEndIds = allContractIds.filter((id) => isActiveAt(id, monthEndInstant));
    const contractsActiveAtStartIds = allContractIds.filter((id) => isActiveAt(id, monthStartInstant));
    const activeAtEndSet = new Set(contractsActiveAtEndIds);
    const activeAtStartSet = new Set(contractsActiveAtStartIds);

    // ── MRR CONTRATADO: inicial / final, with unpriced visibility (F2) ──
    let mrrInicialArs = 0;
    for (const id of contractsActiveAtStartIds) {
      const p = priceInfoAt(id, monthStartInstant);
      if (p.priced) mrrInicialArs += p.price;
    }
    mrrInicialArs = round2(mrrInicialArs);

    let mrrFinalArs = 0;
    let unpricedContractsActive = 0;
    for (const id of contractsActiveAtEndIds) {
      const p = priceInfoAt(id, monthEndInstant);
      if (p.priced) mrrFinalArs += p.price;
      else unpricedContractsActive += 1;
    }
    mrrFinalArs = round2(mrrFinalArs);
    const unpricedContractsPct = contractsActiveAtEndIds.length > 0 ? round2((unpricedContractsActive / contractsActiveAtEndIds.length) * 100) : 0;

    const inMonth = (iso: string) => new Date(iso) >= monthStart && new Date(iso) < monthEnd;

    // Raw activity counts (informational — NOT the churn-rate-safe sets, see below).
    const activatedThisMonth = allContractIds.filter((id) =>
      (eventsByContract.get(id) ?? []).some((e) => (e.eventType === 'activated' || e.eventType === 'reactivated') && inMonth(e.createdAt)),
    );
    const deactivatedThisMonth = allContractIds.filter((id) =>
      (eventsByContract.get(id) ?? []).some((e) => e.eventType === 'deactivated' && inMonth(e.createdAt)),
    );

    // mrrNewArs (F7) — new-this-month AND still active at month-end use the
    // FINAL known price (subsumes any subsequent mid-month upgrade/downgrade
    // — see "how the bridge closes" above). New-this-month contracts that
    // also churned same month contribute 0 here (not in contractsActiveAtEndIds).
    // CRUCIALLY excludes anything already in `contractsActiveAtStartIds` —
    // `activatedThisMonth`'s raw definition includes 'reactivated', so a
    // baja+re-alta same month (F7's "client never really left") would
    // otherwise double-count: its price is ALREADY inside mrrInicialArs, so
    // counting it again here would break the bridge identity by exactly its
    // price (this contract contributes 0 net, not +price).
    let mrrNewArs = 0;
    for (const id of activatedThisMonth) {
      if (!activeAtEndSet.has(id) || activeAtStartSet.has(id)) continue;
      const p = priceInfoAt(id, monthEndInstant);
      if (p.priced) mrrNewArs += p.price;
    }
    mrrNewArs = round2(mrrNewArs);

    // mrrChurnArs (F3/F7) — ONLY contracts that were active at month START,
    // deactivated this month, AND are NOT active at month end (excludes
    // alta+baja-same-month [F3: never in activeAtStart] and
    // baja+re-alta-same-month [F7: back in activeAtEnd]). Priced at
    // month-end reference (walks 'modified' history regardless of
    // active/inactive state, so it picks up an upgrade that happened before
    // the churn — see "how the bridge closes" above).
    const churnedTrueIds = contractsActiveAtStartIds.filter((id) => deactivatedThisMonth.includes(id) && !activeAtEndSet.has(id));
    let mrrChurnArs = 0;
    for (const id of churnedTrueIds) {
      const p = priceInfoAt(id, monthEndInstant);
      if (p.priced) mrrChurnArs += p.price;
    }
    mrrChurnArs = round2(mrrChurnArs);

    // ── Upgrade/downgrade COUNTS (kbps-based, ALL contracts) vs MONEY (price-sign-based, activeAtStart-scoped only) ──
    let contractsUpgraded = 0;
    let contractsDowngraded = 0;
    for (const id of allContractIds) {
      const modEvents = (eventsByContract.get(id) ?? []).filter(
        (e) => e.eventType === 'modified' && !e.changeKind && e.oldPlan && e.newPlan && inMonth(e.createdAt),
      );
      for (const e of modEvents) {
        const direction = deriveDirection('modified', e.oldPlan, e.newPlan, kbpsByCode);
        if (direction === 'upgrade') contractsUpgraded += 1;
        else if (direction === 'downgrade') contractsDowngraded += 1;
      }
    }

    let mrrUpgradeArs = 0;
    let mrrDowngradeArs = 0;
    let unpricedPlanChangeEvents = 0;
    // fix-wave-3 (🔴 1) — the COUNTS loop above (`contractsUpgraded`/
    // `contractsDowngraded`) already excludes enforcement-plan events via
    // `deriveDirection`'s own `isEnforcementPlan` guard, and `resolvedPlanCodeAt`
    // (mrrInicial/mrrFinal) rewinds PAST them — but this MONEY loop read
    // `e.oldPlan`/`e.newPlan` raw, with no such guard. `IP-REDUCCION`/
    // `IP-BAJA` are ordinary rows in the `Plan` catalog (reachable from the
    // UI: `GetFinancePlanPrices` lists them, `UpdateFinancePlanPrice` lets an
    // operator price them) — a manual plan-change landing on one of them
    // (bypassing reduce/restore) was being counted as a REAL price-sign
    // upgrade/downgrade, even though it's never the contract's real
    // commercial intent. Measured: a single IP-100(15000)→IP-REDUCCION
    // (priced 5000) event alone produced a fake mrrDowngradeArs of 10000 —
    // a -10000 gap against the contract's REAL, unchanged mrrFinalArs.
    let enforcementPlanChangeEventsExcluded = 0;
    for (const id of contractsActiveAtStartIds) {
      const modEvents = (eventsByContract.get(id) ?? []).filter(
        (e) => e.eventType === 'modified' && !e.changeKind && e.oldPlan && e.newPlan && inMonth(e.createdAt),
      );
      for (const e of modEvents) {
        if (isEnforcementPlan(e.oldPlan!) || isEnforcementPlan(e.newPlan!)) {
          enforcementPlanChangeEventsExcluded += 1;
          continue;
        }
        const oldPrice = planPricesByCode.get(e.oldPlan!);
        const newPrice = planPricesByCode.get(e.newPlan!);
        if (oldPrice === undefined || newPrice === undefined) {
          unpricedPlanChangeEvents += 1;
          continue;
        }
        const delta = newPrice - oldPrice;
        if (delta > 0) mrrUpgradeArs += delta;
        else if (delta < 0) mrrDowngradeArs += -delta;
      }
    }
    mrrUpgradeArs = round2(mrrUpgradeArs);
    mrrDowngradeArs = round2(mrrDowngradeArs);

    if (unpricedPlanChangeEvents > 0) {
      console.warn(
        `[finance-growth] BuildFinanceMonthlySnapshot(${yearMonth}): ${unpricedPlanChangeEvents} plan-change event(s) had an unresolvable old/new price — excluded from mrrUpgradeArs/mrrDowngradeArs (never guessed as 0), see unpricedPlanChangeEvents.`,
      );
    }
    if (enforcementPlanChangeEventsExcluded > 0) {
      console.warn(
        `[finance-growth] BuildFinanceMonthlySnapshot(${yearMonth}): ${enforcementPlanChangeEventsExcluded} plan-change event(s) landed on an enforcement code (IP-REDUCCION/IP-BAJA) — excluded from mrrUpgradeArs/mrrDowngradeArs (never a real commercial change), see enforcementPlanChangeEventsExcluded.`,
      );
    }
    if (unpricedContractsActive > 0) {
      console.warn(
        `[finance-growth] BuildFinanceMonthlySnapshot(${yearMonth}): ${unpricedContractsActive} of ${contractsActiveAtEndIds.length} active contract(s) have an unresolvable contracted price — excluded from mrrFinalArs, see unpricedContractsActive/unpricedContractsPct.`,
      );
    }

    const contractsActive = contractsActiveAtEndIds.length;
    const contractsNew = activatedThisMonth.length;
    const contractsChurned = deactivatedThisMonth.length;

    const churnContractsPct = contractsActiveAtStartIds.length > 0 ? round2((churnedTrueIds.length / contractsActiveAtStartIds.length) * 100) : 0;
    // F4 — null (not 0) when there's no starting base AT ALL (no previous
    // reliance on a stored snapshot anymore — mrrInicialArs/contractsActiveAtStartIds
    // are both computed fresh above, so a "mes salteado" can no longer zero
    // this out silently). When there IS a contract base but $0 of it priced
    // (edge case: every starting contract unpriced), 0% is the honest
    // answer — there's genuinely nothing measurable in money terms to have
    // lost, never a divide-by-zero.
    const churnRevenuePct =
      contractsActiveAtStartIds.length === 0 ? null : mrrInicialArs > 0 ? round2((mrrChurnArs / mrrInicialArs) * 100) : 0;

    // ── COBRANZA REAL (Capa A) — cash puro, SIN bridge, TODO el universo (decisión LOCK). ──
    const monthItems = await this.itemRepo.listByMonth(yearMonth);
    const revenueTotalArs = round2(monthItems.reduce((sum, i) => sum + i.amount, 0));

    // unclassifiedAmountArs — Capa A reconciliation signal, from applications (never mixed into cash). F9: listByMonth now cuts by receipt.fechaRecibo.
    const [monthApplications, classificationRows] = await Promise.all([this.applicationRepo.listByMonth(yearMonth), this.classificationRepo.list()]);
    const classifications = new Map<string, FinanceInvoiceTypeBucket>(classificationRows.map((c) => [c.grType, c.bucket]));
    const { unclassifiedAmount } = netCollectedAmountForMonth(monthApplications, classifications);

    // ── Capa B — cash attributed to internet contracts (diagnostic: attributionPct + ARPU numerator). F6: population fixed to ALL contracts touched this month (activeDuring), not just contractsActiveAtEndIds. ──
    let orphanClientCount = 0;
    const monthAttribution = await this.computeAttributionForMonth(yearMonth, allContractIds, eventsByContract, activeDuring, planCodeAt, planPricesByCode, () => {
      orphanClientCount += 1;
    });

    let revenueInternetAttributedArs = 0;
    let revenueAttributableArs = 0;
    for (const share of monthAttribution.values()) {
      revenueInternetAttributedArs += share.amountArs;
      if (share.attributionConfidence === 'exact') revenueAttributableArs += share.amountArs;
    }
    revenueInternetAttributedArs = round2(revenueInternetAttributedArs);
    revenueAttributableArs = round2(revenueAttributableArs);
    const attributionPct = revenueInternetAttributedArs > 0 ? round2((revenueAttributableArs / revenueInternetAttributedArs) * 100) : 0;

    // TASA DE COBRANZA — conecta las dos series (decisión LOCK #3).
    // fix-wave-3 (🔴 2) — numerator FIXED to `revenueInternetAttributedArs`
    // (Capa B, internet-only), matching the denominator's population
    // (`mrrFinalArs`, also internet-only). The numerator used to be
    // `revenueTotalArs` (Capa A, cash from the WHOLE company, including
    // TV-only clients per decision LOCK) — mixing a whole-company numerator
    // against an internet-only denominator let this exceed 100% for a
    // client base that paid EXACTLY what it owed. Measured: 1 internet
    // contract (MRR 10000) paying exactly 10000 + a TV-only client paying
    // 40000 produced `collectionRatePct: 500` — the truth is 100%.
    const collectionRatePct = mrrFinalArs > 0 ? round2((revenueInternetAttributedArs / mrrFinalArs) * 100) : null;

    // ARPU (F5) — cash attributed to contracts STILL active at month-end
    // (Capa B), divided by contractsActive. NEVER revenueTotalArs (the
    // whole-company Capa A figure, which includes non-internet clients).
    let internetCashAtEnd = 0;
    for (const id of contractsActiveAtEndIds) internetCashAtEnd += monthAttribution.get(id)?.amountArs ?? 0;
    internetCashAtEnd = round2(internetCashAtEnd);
    const arpuArs = contractsActive > 0 ? round2(internetCashAtEnd / contractsActive) : 0;

    if (orphanClientCount > 0) {
      console.warn(
        `[finance-growth] BuildFinanceMonthlySnapshot(${yearMonth}): ${orphanClientCount} client(s) with contracts but no resolvable grClienteId — their cash could not be attributed (counted as 0, month computation NOT aborted).`,
      );
    }

    // ── bridgeResidualArs (fix-wave-3 🟡 4) — the identity's residual, made
    // VISIBLE as its own field. EXACTLY 0 in the healthy case (bridge closes
    // by construction — see "HOW THE BRIDGE CLOSES" above); non-zero is a
    // real gap (an unresolvable price on one side of a transition, a
    // 'modified' event lost by `ChangePppoePlanService`'s best-effort
    // try/catch, or any future case not yet accounted for) that used to have
    // NO signal pointing at it at all.
    const bridgeResidualArs = round2(mrrFinalArs - (mrrInicialArs + mrrNewArs + mrrUpgradeArs - mrrDowngradeArs - mrrChurnArs));
    if (bridgeResidualArs !== 0) {
      console.warn(
        `[finance-growth] BuildFinanceMonthlySnapshot(${yearMonth}): bridge did NOT close — bridgeResidualArs=${bridgeResidualArs} (mrrFinalArs vs mrrInicial+new+upgrade-downgrade-churn). Check unpricedContractsActive/unpricedPlanChangeEvents/enforcementPlanChangeEventsExcluded for a likely cause.`,
      );
    }

    return this.snapshotRepo.upsert(yearMonth, {
      contractsActive,
      contractsNew,
      contractsChurned,
      contractsUpgraded,
      contractsDowngraded,
      mrrInicialArs,
      mrrNewArs,
      mrrUpgradeArs,
      mrrDowngradeArs,
      mrrChurnArs,
      mrrFinalArs,
      bridgeResidualArs,
      unpricedContractsActive,
      unpricedContractsPct,
      unpricedPlanChangeEvents,
      enforcementPlanChangeEventsExcluded,
      revenueTotalArs,
      collectionRatePct,
      revenueAttributableArs,
      unclassifiedAmountArs: unclassifiedAmount,
      attributionPct,
      arpuArs,
      churnContractsPct,
      churnRevenuePct,
    });
  }

  /** Computes Capa B attribution (cash puro, atribuido a contrato) for every contract active DURING `yearMonth` — includes contracts that churned mid-month (F6), grouped by client. */
  private async computeAttributionForMonth(
    yearMonth: string,
    allContractIds: string[],
    eventsByContract: Map<string, ContractServiceEventWithClient[]>,
    activeDuring: (contractId: string, start: Date, endExclusive: Date) => boolean,
    planCodeAt: (contractId: string, at: Date) => string | null,
    planPricesByCode: Map<string, number>,
    onOrphan: () => void,
  ): Promise<Map<string, AttributedContractShare>> {
    const { start, endExclusive } = yearMonthToDateRange(yearMonth);
    const activeContractIds = allContractIds.filter((id) => activeDuring(id, start, endExclusive));

    const contractsByClient = new Map<string, string[]>();
    for (const id of activeContractIds) {
      const clientId = (eventsByContract.get(id) ?? []).find((e) => e.clientId)?.clientId ?? null;
      if (!clientId) continue; // no client resolvable at all — nothing to attribute, nothing to orphan-count either
      const list = contractsByClient.get(clientId);
      if (list) list.push(id);
      else contractsByClient.set(clientId, [id]);
    }

    const grIdByClientId = await this.clientLinks.getGrClienteIdsByClientIds([...contractsByClient.keys()]);

    const result = new Map<string, AttributedContractShare>();
    for (const [clientId, contractIds] of contractsByClient) {
      const grClienteId = grIdByClientId.get(clientId);
      if (!grClienteId) {
        onOrphan();
        for (const cid of contractIds) result.set(cid, { contractId: cid, amountArs: 0, attributionConfidence: 'estimated-equal' });
        continue;
      }
      const items = await this.itemRepo.listByClientAndMonth(grClienteId, yearMonth);
      const collectedAmountArs = round2(items.reduce((sum, i) => sum + i.amount, 0));
      const attributable = contractIds.map((cid) => ({ contractId: cid, planCode: planCodeAt(cid, new Date(endExclusive.getTime() - 1)) }));
      const shares = attributeCollectedAmountToContracts(collectedAmountArs, attributable, planPricesByCode);
      for (const s of shares) result.set(s.contractId, s);
    }
    return result;
  }
}
