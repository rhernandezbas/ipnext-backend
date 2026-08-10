# Client Detail Balance Specification

## Purpose

`GetClientDetail` (used by `GET /api/clients/:id`, which returns the `Customer` entity as-is —
no separate DTO) is the panel's "ficha". This spec documents its contract once
`customer-balance-truth` stops masking: the ficha shows the real number for every status, keeps
its existing on-open refresh, and shows stale data WITH its timestamp instead of hiding it.

## Requirements

### Requirement: the ficha reports the real balance for every status
`GET /api/clients/:id` MUST return `balanceDue`/`balanceCurrency`/`balanceStale`/`lastBalanceAt`
exactly as produced by `toCustomer` — no additional masking at the route or use-case level.

#### Scenario: active client with real debt
- GIVEN an active client with `balanceDue=45000` in the row, fresh (`balanceStale=false`)
- WHEN `GET /api/clients/:id` is called
- THEN the response has `balanceDue: 45000` (not the old hardcoded `0`)

### Requirement: on-open refresh is preserved unchanged
`GetClientDetail.execute` MUST keep calling `RefreshClientBalanceIfStale` for **any** client with
a `grClienteId` (not just debtors), re-reading the row when the refresh succeeds. This behavior
is NOT modified by this change.

#### Scenario: stale client, refresh succeeds
- GIVEN a client with `grClienteId` set and a stale balance
- WHEN the ficha is opened
- THEN `RefreshClientBalanceIfStale` is attempted, and on success the response reflects the fresh
  `balanceDue`/`balanceCurrency`/`lastBalanceAt`

#### Scenario: refresh fails or times out
- GIVEN GR is unreachable within the refresh timeout
- WHEN the ficha is opened
- THEN the response falls back to the last stored `balanceDue` with `balanceStale: true` — the
  request never throws

### Requirement: stale data is shown, not hidden
The response payload MUST carry `balanceDue`, `balanceStale: true`, and the (old) `lastBalanceAt`
together when a refresh attempt does not freshen the data — the BE never nulls out a known,
aging number just because it's stale. (Formatting "número + antigüedad" for a human is a FE
concern, out of scope here; this requirement only pins the data contract.)

#### Scenario: stale-but-known balance still ships all three fields
- GIVEN a stored `balanceDue=12000`, `lastBalanceAt` = 3 hours ago, TTL = 60 min, refresh fails
- WHEN the ficha responds
- THEN `balanceDue: 12000`, `balanceStale: true`, `lastBalanceAt` = the 3-hour-old timestamp

### Requirement: unlinked clients are unaffected by refresh
Clients without `grClienteId` MUST continue to skip the refresh attempt entirely (unchanged) and
report `balanceDue: null` per `customer-balance-truth`.

#### Scenario: no GR link
- GIVEN a client with `grClienteId: null`
- WHEN the ficha is opened
- THEN no refresh call is attempted, and `balanceDue: null` in the response
