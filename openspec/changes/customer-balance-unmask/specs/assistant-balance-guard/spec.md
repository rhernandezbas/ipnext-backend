# Assistant Balance Guard Specification

## Purpose

`ClienteSaldoResolver` (`cliente.saldo`) is the bot's ONLY guard against telling a WhatsApp
customer a wrong number about their own money. It keeps the strictest gate of the three surfaces:
it never emits a number it doesn't trust — it hands off to a human instead. This spec (a) kills
the dead-code wiring bug that makes its refresh attempt a no-op in prod, (b) fixes the original
masking bug for the bot, and (c) closes a currency-defaulting gap the exploration surfaced.

## Requirements

### Requirement: refreshBalance is wired at the composition root
`app.ts` MUST pass `refreshBalance` when constructing `composeAssistantEngine`. Today it omits
it (`app.ts` composeAssistantEngine call), making `ClienteSaldoResolver`'s refresh branch
unreachable in production even though `balanceRefresh` already exists in scope there.

#### Scenario: composition wires the collaborator
- GIVEN `app.ts` builds `assistantEngine` via `composeAssistantEngine(...)`
- THEN the call includes a `refreshBalance: RefreshClientBalanceIfStale` instance

#### Contra-scenario (revert probe)
- GIVEN `refreshBalance` is omitted from the composition call
- THEN a composition-root test MUST fail (mirrors the existing `assistant-composition.test.ts`
  precedent for this exact class of bug — wired route, uninjected hook)

### Requirement: a fresh, real balance is reported for any status
`ClienteSaldoResolver.resolve` MUST report `disponible:true, saldo, moneda, tieneDeuda,
estadoCliente` for a client whose balance is fresh and known, regardless of `CustomerStatus` —
this is the original bug, now closed.

#### Scenario: active client with real debt, fresh (the bug is dead)
- GIVEN an active client, `grClienteId` set, `balanceDue=45000`, `balanceCurrency='ARS'`,
  `balanceStale=false` — built via `toCustomer` on a plausible row (per `customer-balance-truth`)
- WHEN `resolve()` runs
- THEN `{disponible:true, saldo:45000, moneda:'ARS', tieneDeuda:true, estadoCliente:'active'}`

### Requirement: stale data is never emitted, even after a refresh attempt
If the balance is stale, the resolver MUST try `refreshBalance` first; if it's still stale
afterward (GR down, timeout, or genuinely not due for refresh), it MUST return
`disponible:false, motivo:'saldo_desactualizado'` and MUST NOT include `saldo`.

#### Scenario: yesterday's balance, today's TTL, refresh fails
- GIVEN `lastBalanceAt` = yesterday (older than TTL), `grClienteId` set, GR call fails
- WHEN `resolve()` runs
- THEN `{disponible:false, motivo:'saldo_desactualizado'}` — no number leaves the bot

#### Scenario: stale, but the refresh succeeds
- GIVEN the same starting state, but `refreshBalance.execute` returns `true`
- WHEN `resolve()` re-reads the customer
- THEN it emits the freshened `saldo` (existing re-check logic, unaffected by this change)

### Requirement: unknown balance means "no sé", never a fabricated zero
When `balanceDue` is `null` (no `grClienteId`, or never fetched — per `customer-balance-truth`),
the resolver MUST return `disponible:false, motivo:'saldo_nunca_consultado'`.

#### Scenario: client with no GR link
- GIVEN `grClienteId: null` (`balanceDue: null` per the mapper)
- WHEN `resolve()` runs
- THEN `{disponible:false, motivo:'saldo_nunca_consultado'}`

### Requirement: unconfirmed currency is never assumed to be ARS
The resolver MUST NOT default `moneda` to `'ARS'` when `balanceCurrency` is missing on an
otherwise-trusted, non-null `balanceDue`. An unconfirmed currency MUST hand off to a human instead
of guessing.

#### Scenario: trusted balance, unconfirmed currency
- GIVEN `balanceDue=1000`, `balanceCurrency: null`, `balanceStale=false`
- WHEN `resolve()` runs
- THEN `{disponible:false, motivo:'moneda_no_confirmada'}` — NOT `moneda:'ARS'`

#### Scenario: regression — confirmed currency still emits normally
- GIVEN `balanceDue=1000`, `balanceCurrency:'ARS'`, `balanceStale=false`
- WHEN `resolve()` runs
- THEN `{disponible:true, saldo:1000, moneda:'ARS', ...}`
