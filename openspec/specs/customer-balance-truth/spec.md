# Customer Balance Truth Specification

## Purpose

`toCustomer` (`PrismaCustomerRepository.ts`) is the ONE mapper that turns the `Client` row into
the `Customer` entity every surface reads (`findById`/`list`). This spec makes it stop lying
about `balanceDue` for anyone who isn't `status='late'`. It is the source-of-truth capability
underneath `client-detail-balance`, `inbox-client-balance`, and `assistant-balance-guard`.

## Requirements

### Requirement: balanceDue reflects the row for every status
`toCustomer` MUST map `balanceDue` and `balanceCurrency` from the row's columns for **every**
`CustomerStatus`, not only `'late'`. It MUST NOT force `balanceDue` to `0` based on status.

#### Scenario: active client with real debt
- GIVEN a row with `status='active'`, `grClienteId` set, `balanceDue=45000`, `balanceCurrency='ARS'`
- WHEN `toCustomer(row, ttl)` runs
- THEN the result has `balanceDue: 45000`, `balanceCurrency: 'ARS'` (not zeroed)

#### Scenario: late client, unchanged parity
- GIVEN a row with `status='late'`, `balanceDue=1000`
- WHEN `toCustomer(row, ttl)` runs
- THEN `balanceDue: 1000` — identical to pre-change behavior

### Requirement: no GR link means no verified data
When `row.grClienteId` is null/undefined, `toCustomer` MUST return `balanceDue: null` and
`balanceCurrency: null`, **regardless of any value present in the row's columns** — no refresh
lane has ever touched that row, so the column cannot be trusted.

#### Scenario: unlinked client with a stray column value
- GIVEN `grClienteId: null`, `row.balanceDue: 500` (leftover/manual value)
- WHEN `toCustomer(row, ttl)` runs
- THEN `balanceDue: null` (never `500`, never `0`)

#### Scenario: linked client, normal path
- GIVEN `grClienteId: 'GR123'`, `row.balanceDue: 500`
- WHEN `toCustomer(row, ttl)` runs
- THEN `balanceDue: 500`

### Requirement: staleness is status-agnostic
`balanceStale` MUST be derived from `isBalanceOlderThanTtl(lastBalanceAt, ttlMinutes, now)` —
the same helper `RefreshClientBalanceIfStale` and `GetInboxClientContext` already use. It MUST
NOT branch on `status`.

#### Scenario: fresh active client
- GIVEN `status='active'`, `lastBalanceAt` = 10 minutes ago, `ttl=60`
- THEN `balanceStale: false`

#### Scenario: never fetched
- GIVEN `lastBalanceAt: null` (any status, including one with no `grClienteId`)
- THEN `balanceStale: true`

### Requirement: currency is passed through unmodified
`balanceCurrency` MUST be the raw column value (including `null`) — the mapper MUST NOT default
or coerce it to `'ARS'`. (The GR ingest's own `'ARS'` hardcoding at parse time is a separate,
pre-existing bug — out of scope here.)

#### Scenario: non-ARS currency survives
- GIVEN `row.balanceCurrency: 'DOL'`
- THEN `balanceCurrency: 'DOL'`

### Requirement: downstream fixtures must be mapper-producible
Any automated test that asserts behavior against a `Customer` value (in
`ClienteSaldoResolver`/`GetInboxClientContext`/`GetClientDetail` specs and their tests) MUST
construct that `Customer` via `toCustomer(row, ttl)` against a plausible row — not a hand-built
object carrying a `status`/`balanceDue` pair the real mapper cannot produce.

#### Scenario: bot fixture goes through the real mapper
- GIVEN a row `{status:'active', grClienteId:'GR1', balanceDue:45000, balanceCurrency:'ARS',
  lastBalanceAt: now}`
- WHEN the test builds its fixture via `toCustomer(row, ttl)`
- THEN the resulting `Customer` is what the resolver test asserts against

#### Contra-scenario (revert probe)
- GIVEN a fixture authored directly as `{status:'active', balanceDue:45000}`, bypassing the mapper
- THEN this MUST be rejected in review — pre-fix `toCustomer` could never produce that pair; this
  is the exact shape that certified the masking bug as "tested"

### Requirement: portal self-service balance is untouched
`GetPortalMe` / `getPortalBalanceSummary` (invoice-derived, scoped to the authenticated portal
account) MUST NOT be modified by this change and MUST remain the exclusive source for
`/api/portal/*` balance responses.

#### Scenario: portal contract and anti-IDOR scope unchanged
- GIVEN a portal JWT for `clientId=X`
- WHEN `GET /api/portal/me` or `/api/portal/invoices` is called
- THEN the balance is still derived from `getPortalBalanceSummary` (invoices), unaffected by the
  `toCustomer` unmask, and scoped only to `X`
