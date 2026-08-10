# Inbox Client Balance Specification

## Purpose

`GetInboxClientContext.buildClientSummary` feeds the human agent's inbox panel
(`FinancialSection.tsx`) with `balance.due/currency/isDebtor/stale/lastRefreshedAt`. Its
staleness math was already status-agnostic (`isBalanceOlderThanTtl`) before this change; only
`due` was corrupted upstream by the masked mapper. This spec pins that `due` now tells the truth
and that the already-correct staleness/refresh behavior does not regress.

## Requirements

### Requirement: balance.due is the real, unmasked number
`buildClientSummary` MUST derive `balance.due` from `customer.balanceDue` as produced by the
unmasked `toCustomer` — a real number (or `null`) for every status, not a status-gated zero.

#### Scenario: active client with real debt
- GIVEN an active client with `balanceDue=45000`
- WHEN the inbox context is built
- THEN `balance.due: 45000`, `balance.isDebtor: true` (`due != null && due > 0`)

### Requirement: staleness computation is unchanged
`balance.stale` MUST continue to be computed via `isBalanceOlderThanTtl(customer.lastBalanceAt,
ttlMinutes)` — the same helper and TTL used by `RefreshClientBalanceIfStale` and
`customer-balance-truth`'s `balanceStale`. No behavior change here; this is a regression pin.

#### Scenario: same TTL, same verdict everywhere
- GIVEN a `lastBalanceAt` older than the TTL, on any status
- THEN `balance.stale: true` — identical to the verdict `toCustomer` and
  `RefreshClientBalanceIfStale` would compute for the same input

### Requirement: unlinked clients keep reporting "no data"
Clients without `grClienteId` MUST continue to yield `balance.due: null` — this was already
correct before the change (the inbox never relied on the masked field) and must not regress.

#### Scenario: no GR link
- GIVEN `grClienteId: null`
- WHEN the inbox context is built
- THEN `balance.due: null`

### Requirement: on-demand refresh path is unaffected
The `?refresh=true` path (calling `RefreshClientBalanceIfStale` then re-deriving `due`/`stale`
from the fresh customer) MUST keep working exactly as before.

#### Scenario: agent forces a refresh
- GIVEN `params.refresh === true` and a stale client with `grClienteId`
- WHEN `buildClientSummary` runs
- THEN `RefreshClientBalanceIfStale.execute` is called, and on success `balance.due`/`stale` are
  re-derived from the freshly re-read customer
