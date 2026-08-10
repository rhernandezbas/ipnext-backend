# Balance Staleness Helper Specification

## Purpose

Two staleness helpers exist today with different, colliding semantics: the private, status-aware
`isBalanceStale(status, lastBalanceAt, ttlMinutes)` in `PrismaCustomerRepository.ts` (returns
`false` for anyone not `'late'`, independent of age), and the public, status-agnostic
`isBalanceOlderThanTtl(lastBalanceAt, ttlMinutes, now)` already used by `RefreshClientBalanceIfStale`
and `GetInboxClientContext`. This spec retires the status-aware one so all three surfaces share
ONE staleness criterion.

## Requirements

### Requirement: the status-aware helper is removed
The private `isBalanceStale(status, lastBalanceAt, ttlMinutes)` function MUST be deleted from
`PrismaCustomerRepository.ts`. No caller anywhere in `src/` may depend on status-gated staleness
(`status !== 'late' → false`) again.

#### Scenario: no trace of the old signature
- GIVEN a search for the 3-arg, status-first staleness helper across `src/`
- THEN it returns zero matches (outside of history/comments)

#### Contra-scenario (revert probe)
- GIVEN a future change reintroduces a call that keys staleness off `status==='late'`
- THEN a pinning test MUST fail — this is the exact bug this change exists to kill, and it must
  not be able to come back silently

### Requirement: one staleness criterion for every caller
`Customer.balanceStale` (via `toCustomer`), `GetInboxClientContext.buildClientSummary`'s
`balance.stale`, and `RefreshClientBalanceIfStale`'s internal gate MUST all evaluate
`isBalanceOlderThanTtl(lastBalanceAt, ttlMinutes, now)` against the SAME `lastBalanceAt` and the
SAME TTL **for the same lane** — i.e. all three MUST derive the TTL through
`balanceTtlMinutesForStatus(status, configuredTtl)`, never with a locally computed value.

The TTL is per-LANE, not global: the base is refreshed on two cadences (fast, hourly; slow, once
a day for `baja`), and a single TTL made every `baja` permanently stale.

#### Scenario: identical verdict across all three call sites
- GIVEN the same `lastBalanceAt` and `ttlMinutes`, on any `CustomerStatus`
- WHEN each of the three call sites evaluates staleness
- THEN all three return the same boolean — no drift between "the ficha thinks it's fresh" and
  "the bot thinks it's stale"

### Requirement: every lane's TTL is "cadence + margin"
A lane's TTL MUST leave room for the batch that feeds it. `lastBalanceAt` is stamped when the
batch REACHES a given client, not when its window opens, so a TTL equal to the cadence marks a
client stale before the next pass can possibly reach it.

- SLOW lane: `SLOW_LANE_BALANCE_TTL_MINUTES` = 24h cadence + 2h margin = 26h (constant).
- FAST lane: the CONFIGURED TTL + `FAST_LANE_BATCH_MARGIN_MINUTES` (60min, covering the ~43min
  measured for the 5,582-client pass). With the production default this is an effective 2h.

The margin is ADDED to the configured TTL, never substituted for it: `BALANCE_STALE_TTL_MINUTES`
must remain a live knob (a constant would make the injected TTL decoration again — mutant M5).

A zero margin is not a stricter criterion, it is a false one: it declares stale the freshest data
the lane can produce, and every such client then triggers an on-demand GR refresh (one per
WhatsApp message, one per opened ficha) that cannot improve anything.

#### Scenario: the fast lane's effective TTL includes the batch margin
- GIVEN `balanceTtlMinutesForStatus('active', 60)`
- THEN it returns `120` — 60 configured + 60 of margin

#### Scenario: the knob still moves the effective TTL
- GIVEN two configured TTLs, one lower than the other
- THEN the effective fast-lane TTLs preserve that ordering

#### Scenario: the slow lane does NOT get the margin added twice
- GIVEN a `baja`
- THEN the TTL is exactly `SLOW_LANE_BALANCE_TTL_MINUTES` (its margin is already inside)

### Requirement: never-fetched is always stale
`isBalanceOlderThanTtl` MUST treat a `null`/`undefined` `lastBalanceAt` as stale (`true`),
regardless of status or `grClienteId` presence — this is what makes unlinked clients naturally
stale without a special case (see `customer-balance-truth`).

#### Scenario: no timestamp yet
- GIVEN `lastBalanceAt: null`
- THEN `isBalanceOlderThanTtl(...)` returns `true`
