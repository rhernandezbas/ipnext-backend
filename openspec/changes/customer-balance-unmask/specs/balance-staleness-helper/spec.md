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
SAME TTL default (`DEFAULT_BALANCE_STALE_TTL_MINUTES = 60`).

#### Scenario: identical verdict across all three call sites
- GIVEN the same `lastBalanceAt` and `ttlMinutes`, on any `CustomerStatus`
- WHEN each of the three call sites evaluates staleness
- THEN all three return the same boolean — no drift between "the ficha thinks it's fresh" and
  "the bot thinks it's stale"

### Requirement: never-fetched is always stale
`isBalanceOlderThanTtl` MUST treat a `null`/`undefined` `lastBalanceAt` as stale (`true`),
regardless of status or `grClienteId` presence — this is what makes unlinked clients naturally
stale without a special case (see `customer-balance-truth`).

#### Scenario: no timestamp yet
- GIVEN `lastBalanceAt: null`
- THEN `isBalanceOlderThanTtl(...)` returns `true`
