/**
 * finance-growth Fase 3 — pure contract-lifecycle replay over
 * `ContractServiceEvent` history, shared by `BuildFinanceMonthlySnapshot`
 * (bridge/churn) and `BuildFinanceCohortSnapshot` (retention). Extracted so
 * both use cases agree on the exact SAME definition of "active at a point in
 * time" — a divergence here (e.g. one counting 'reactivated' and the other
 * not) would silently make the bridge and the cohort matrix tell two
 * different stories about the same contracts.
 *
 * Scope: only 'activated'/'reactivated' (→ active) and 'deactivated'
 * (→ inactive) affect membership. 'modified'/'reduced'/'blocked'/'restored'
 * do not change active/inactive state for MRR-bridge purposes (a reduced/
 * blocked contract is still commercially active, just rate-limited) — a
 * deliberate simplification not spelled out in design.md, documented here.
 */

import { isEnforcementPlan } from '@domain/entities/plan';

export interface LifecycleEvent {
  eventType: string;
  createdAt: string; // ISO
  oldPlan?: string | null;
  newPlan?: string | null;
  changeKind?: string | null;
}

/** True when the contract (given its FULL, chronologically-ASCENDING event history) is active at `at`. */
export function isContractActiveAt(events: LifecycleEvent[], at: Date): boolean {
  let active = false;
  for (const e of events) {
    if (new Date(e.createdAt) > at) break;
    if (e.eventType === 'activated' || e.eventType === 'reactivated') active = true;
    else if (e.eventType === 'deactivated') active = false;
  }
  return active;
}

function isPlanChangeEvent(e: LifecycleEvent): boolean {
  return e.eventType === 'modified' && !e.changeKind && !!e.oldPlan && !!e.newPlan;
}

/**
 * finance-growth fix-wave-2 — the contract's plan code as of `at`, sourced
 * from `currentProfile` (the contract's `PppoeService.profile` AS OF NOW —
 * batch-resolved by the caller via
 * `PppoeServiceRepository.findCurrentProfilesByContractIds`, `null` when no
 * PPPoE service is resolvable for the contract at all) and REWOUND through
 * the contract's OWN `'modified'` plan-change history back to `at`.
 *
 * WHY `profile`, not `Contract.plan`, not `ContractServiceEvent` alone: the
 * ONLY writer of `profile` is `ChangePppoePlanService`, and it stamps the
 * EXACT SAME value onto the `'modified'` event it records (`oldPlan:
 * service.profile ?? null, newPlan: profile`) — so `profile` and the
 * `oldPlan`/`newPlan` vocabulary are, by construction, the same thing. The
 * OLD approach (deriving the plan EXCLUSIVELY from 'modified' events, see
 * git history) left a contract `null` — unresolvable, unpriced — for its
 * ENTIRE lifetime whenever it never had a real plan-change event, which is
 * most stable, never-upgraded contracts in production. Anchoring on
 * `profile` instead gives FULL coverage for every contract with a PPPoE
 * service (i.e. every contract that is actually connected to the internet),
 * because `profile` always holds the CURRENT plan regardless of whether it
 * was ever changed.
 *
 * ALGORITHM: start at `currentProfile` (the plan NOW) and undo, in
 * reverse-chronological order, every `'modified'` plan-change event whose
 * `createdAt > at` (replacing the running code with that event's `oldPlan`)
 * — this replays history backwards to reconstruct what the plan was AT
 * `at`, not merely what it is today. `events` MUST be chronologically
 * ASCENDING (same contract as `isContractActiveAt`).
 *
 * ENFORCEMENT (`reduced`/`blocked` PPPoE, cut for mora): `PppoeService.profile`
 * is NEVER overwritten by enforcement — `reduce`/`block`/`restore` patch the
 * ROUTER only (`RouterOsEnforcementAdapter`/`OrchestratorEnforcementAdapter`),
 * never call `repo.upsertByUsername`. So a contract cut for mora already
 * carries its real commercial plan in `profile` — no special case needed for
 * `enforcedState`. The ONLY defensive guard below is for the ANOMALOUS case
 * where `profile` itself ended up holding an enforcement code
 * (`IP-REDUCCION`/`IP-BAJA`, `isEnforcementPlan`) via a manual plan change
 * through `ChangePppoePlanService` that bypassed the reduce/restore flow —
 * in that case this function keeps rewinding PAST the enforcement code
 * (regardless of `at`) to the last known real commercial code, so a NOC
 * mistake never silently zeroes a contract's contracted MRR. If no
 * commercial code is EVER found (the contract's entire resolvable history is
 * enforcement codes), returns `null` — honestly unpriced, never a guess.
 */
export function resolvedPlanCodeAt(events: LifecycleEvent[], at: Date, currentProfile: string | null): string | null {
  if (currentProfile === null) return null;

  let code: string | null = currentProfile;
  let i = events.length - 1;

  // Phase 1: rewind to `at` by undoing every plan-change event AFTER `at`.
  while (i >= 0 && new Date(events[i].createdAt) > at) {
    if (isPlanChangeEvent(events[i])) code = events[i].oldPlan!;
    i -= 1;
  }

  // Phase 2 (defensive, anomalous-data-only): keep rewinding PAST any
  // lingering enforcement code, regardless of `at`, until a real commercial
  // code turns up or the history runs out.
  while (code !== null && isEnforcementPlan(code) && i >= 0) {
    if (isPlanChangeEvent(events[i])) code = events[i].oldPlan!;
    i -= 1;
  }
  if (code !== null && isEnforcementPlan(code)) return null;

  return code;
}

/** True when the contract has a 'deactivated' event with `createdAt` in `[start, endExclusive)`. */
export function hasDeactivationInRange(events: LifecycleEvent[], start: Date, endExclusive: Date): boolean {
  return events.some((e) => e.eventType === 'deactivated' && new Date(e.createdAt) >= start && new Date(e.createdAt) < endExclusive);
}

/** True when the contract counts as "active during" `[start, endExclusive)` — active at the very end, OR it deactivated at some point inside the window (still owed its share of that window's cash up to then). */
export function isContractActiveDuring(events: LifecycleEvent[], start: Date, endExclusive: Date): boolean {
  const justBeforeEnd = new Date(endExclusive.getTime() - 1);
  return isContractActiveAt(events, justBeforeEnd) || hasDeactivationInRange(events, start, endExclusive);
}

/**
 * The `createdAt` of the EARLIEST 'activated' event — the contract's TRUE
 * "alta" date, used by `BuildFinanceCohortSnapshot` to assign it to a cohort
 * month (spec.md "mes del evento `activated`", literally — NOT `reactivated`).
 * `null` if the contract has no 'activated' event AT ALL in the tracked
 * history — never invents a cohort month from a `reactivated` event.
 *
 * fix-wave (finance-growth Fase 3 rework, F8) — this used to also match
 * 'reactivated', which counted a contract whose FIRST recorded event happens
 * to be a 'reactivated' (its real 'activated' predates the tracked history,
 * or the sequence is legitimately alta→baja→reactivated with the alta
 * outside this window) as a BRAND NEW alta of the reactivation's month —
 * inflating that month's cohort `originalCount` with a contract that isn't
 * actually new. A contract with ONLY 'reactivated' events (no 'activated' at
 * all) now belongs to NO cohort, which is honest: we don't know when it
 * really started, so we don't guess.
 */
export function firstActivationDate(events: LifecycleEvent[]): Date | null {
  for (const e of events) {
    if (e.eventType === 'activated') return new Date(e.createdAt);
  }
  return null;
}
