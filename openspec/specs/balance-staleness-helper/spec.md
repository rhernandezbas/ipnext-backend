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

### Requirement: the effective TTL is the lane's TTL, with no batch margin on the fast lane
`balanceTtlMinutesForStatus` MUST return the CONFIGURED TTL for the fast lane and
`SLOW_LANE_BALANCE_TTL_MINUTES` for the slow lane. No margin may be added on top of the fast lane's
configured value.

- SLOW lane: `SLOW_LANE_BALANCE_TTL_MINUTES` = 24h cadence + 2h margin = 26h (constant).
- FAST lane: exactly the configured TTL (`BALANCE_STALE_TTL_MINUTES`, 60min in production).

The two lanes are asymmetric ON PURPOSE, because the error each one absorbs points in the opposite
direction. `lastBalanceAt` is stamped when the batch REACHES a given client, not when its window
opens, so a TTL equal to the cadence flags some clients stale before the next pass can reach them
(up to ~43min of skew on the fast lane, measured over 5,582 clients).

- On the SLOW lane, dropping the margin would flag EVERY `baja` permanently stale (24h cadence vs a
  shorter TTL) — a flag that is always on informs nothing. The margin is what keeps it meaningful.
- On the FAST lane, the skew makes the flag fire EARLY, not never. That is the safe side, and adding
  a margin to suppress it trades the safe error for the unsafe one.

This TTL is not only the display flag: it is ALSO the gate of the on-demand refresh
(`RefreshClientBalanceIfStale`'s internal `isStale`). That refresh does not re-read the batch — it
calls `gr.fetchClientBalance` LIVE. So an on-demand refresh CAN improve on the batch's value, and
widening the fast lane's TTL closes the gate on data the system could have corrected. Measured with
a 60min margin in place: an active client with $45,000 stamped 90 minutes ago who paid 30 minutes
ago got `tieneDeuda:true, saldo:45000` with ZERO calls to GR — serving a stale balance as fresh,
the exact failure mode this change exists to prevent.

The accepted cost is the mirror image: for up to ~43min of batch skew a fresh client may still be
flagged stale and trigger a refresh that changes nothing. Refreshing too often costs one GR call
(collapsed per client by the single-flight and bounded by `maxRetries: 1`); refreshing too rarely
costs a wrong number about a client's money.

`BALANCE_STALE_TTL_MINUTES` must remain a live knob — replacing it with a constant would make the
injected TTL decoration again (mutant M5).

#### Scenario: the fast lane's effective TTL is the configured TTL
- GIVEN `balanceTtlMinutesForStatus('active', 60)`
- THEN it returns `60` — no margin added

#### Scenario: the knob still moves the effective TTL
- GIVEN two configured TTLs, one lower than the other
- THEN the effective fast-lane TTLs preserve that ordering

#### Scenario: the slow lane keeps its own margin
- GIVEN a `baja`
- THEN the TTL is exactly `SLOW_LANE_BALANCE_TTL_MINUTES` (26h — its margin is already inside)

#### Contra-scenario (revert probe): the gate must stay open for a client who just paid
- GIVEN an `active` client whose $45,000 balance was stamped 90 minutes ago (configured TTL 60)
- AND GR reports `debt: "0.00"` live
- WHEN the assistant resolves `cliente.saldo`
- THEN exactly one `fetchClientBalance` call is made and the answer is `tieneDeuda:false, saldo:0`
- AND reintroducing any fast-lane margin MUST make this test fail

### Requirement: never-fetched is always stale
`isBalanceOlderThanTtl` MUST treat a `null`/`undefined` `lastBalanceAt` as stale (`true`),
regardless of status or `grClienteId` presence — this is what makes unlinked clients naturally
stale without a special case (see `customer-balance-truth`).

#### Scenario: no timestamp yet
- GIVEN `lastBalanceAt: null`
- THEN `isBalanceOlderThanTtl(...)` returns `true`
