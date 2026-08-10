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

### Requirement: an unconfirmed currency only blocks a POSITIVE amount
The currency guard MUST NOT apply when `balanceDue <= 0`. A zero (or credit) balance has no
amount to denominate, so the resolver MUST answer "al día" (`disponible:true`,
`tieneDeuda:false`) without a confirmed currency.

This is not a relaxation — it is the guard's correct scope. The write path synthesizes the
currency as `amount > 0 ? 'ARS' : null` (`parseClientBalanceResponse`), so in production
`balanceCurrency === null` is EQUIVALENT to "the client owes nothing". An unconditional guard
therefore handed every up-to-date client (~2,300 on the fast lane) to a human in order to tell
them the one thing the bot already knew how to say.

#### Scenario: client is up to date (GR payload `debt: "0.00"`)
- GIVEN a row produced by `parseClientBalanceResponse` on `cuentas.debt = "0.00"` ⇒
  `balanceDue = 0`, `balanceCurrency = null`, balance fresh
- WHEN `resolve()` runs
- THEN `{disponible:true, saldo:0, tieneDeuda:false, ...}` — NOT `moneda_no_confirmada`

#### Scenario: credit balance (negative debt)
- GIVEN `balanceDue = -5000` (credit), `balanceCurrency: null`, balance fresh
- WHEN `resolve()` runs
- THEN `{disponible:true, saldo:0, moneda:null, tieneDeuda:false, estadoCliente, guia: GUIA_SALDO_A_FAVOR}`
- AND the facts contain NO occurrence of `5000` in any field (see the next requirement)

### Requirement: a signed amount NEVER reaches the facts
When `balanceDue <= 0` the resolver MUST emit `saldo: 0` and `moneda: null` — never the stored
amount. A negative balance MUST NOT be emitted, not even as a negative number.

Two things are lost between the column and the prompt, and both are lost silently:
- the SIGN — the model reads `-5000` as the token `5000` and can restate it as a debt;
- the CURRENCY — a credit is `null` by construction (`amount > 0 ? 'ARS' : null`), so the figure
  is undenominated, which is precisely what the currency guard exists to refuse.

And there is no last line of defence: `buildNumberWhitelist` walks the facts, so an emitted
`-5000` WHITELISTS the string `5000` — "tenés una deuda de 5000" would then pass the number
verifier on a client who has that money IN THEIR FAVOUR.

When `balanceDue < 0` the facts MUST additionally carry `guia: GUIA_SALDO_A_FAVOR`: the amount
cannot be stated, so the copy tells the bot to say the client is up to date and to route the
"how much do I have in credit?" question to a human. That `guia` MUST NOT contain any digit run
of 3+ (it would whitelist itself).

This clamp is asymmetric ON PURPOSE and the asymmetry MUST be preserved: `GetClientDetail` (the
ficha) and `GetInboxClientContext` (the inbox) keep emitting the raw `-5000`, because a human
support agent reads those and a signed credit is legitimate information for them. Only the bot's
facts — read by a model that will restate them to the customer — are clamped.

#### Scenario: the number verifier does not whitelist the credit
- GIVEN the facts produced for a `balanceDue = -5000` client
- WHEN `buildNumberWhitelist({facts, ...})` runs
- THEN `5000` is NOT in the whitelist, and `findUnbackedNumbers('… deuda de 5000 …', wl)`
  reports it as unbacked

#### Scenario: up-to-date client (exactly zero) carries no credit guidance
- GIVEN `balanceDue = 0`
- THEN `{disponible:true, saldo:0, moneda:null, tieneDeuda:false, estadoCliente}` — no `guia`,
  because nothing was left unanswered

#### Scenario: the ficha still shows the credit to a human
- GIVEN the same client (`balanceDue = -5000`)
- WHEN `GetClientDetail.execute` runs
- THEN `balanceDue` is `-5000` — the raw signed value, unclamped

#### Contra-scenario (revert probe)
- GIVEN the resolver goes back to emitting `saldo: customer.balanceDue` on the `<= 0` branch
- THEN both the facts test and the whitelist pin MUST fail

### Requirement: every unavailable fact carries the copy the bot must use
Any `disponible:false` result MUST include a `guia` field with the EXACT wording the bot is to
follow for that `motivo`. A bare `motivo` is an internal snake_case identifier: alone in the
prompt the model improvises, and may read `saldo_desactualizado` as "the client didn't pay" or
quote a number it thinks it remembers from the thread. What to tell the customer is a product
decision, made by us, not by the model on each turn.

No `guia` may authorize quoting an amount — the whole point of `disponible:false` is that there
is no trustworthy number to state.

#### Scenario: every motivo has its guidance
- GIVEN any of the resolver's `disponible:false` paths (`cliente_no_identificado`,
  `saldo_nunca_consultado`, `saldo_desactualizado`, `moneda_no_confirmada`)
- THEN the facts include a non-empty `guia` matching that motivo's entry in `MOTIVO_GUIA`

#### Contra-scenario (revert probe)
- GIVEN a resolver returning `{disponible:false, motivo}` without `guia`
- THEN the exhaustive per-motivo test MUST fail

### Requirement: resolving `cliente.saldo` may mutate the invoice mirror
Resolving the bot's `cliente.saldo` source can trigger `RefreshClientBalanceIfStale`, which
writes to the local mirror: it updates the client's balance AND replace-all-syncs the client's
GR invoices from the same payload. This is a WRITE performed inside the Chatwoot webhook flow,
and it is declared here rather than removed — deliberately.

It is the correct behaviour: it is the same mutation the ficha (`GetClientDetail`) has always
performed, from the same payload, through the same collaborator instance. The refresh is the
mirror catching up with the truth, and the bot has the same right to a truthful mirror as the
ficha. Suppressing the invoice half would leave the balance and the invoices disagreeing —
exactly the split-brain this change closes elsewhere.

Two properties make it safe, and both are required:
- The balance and the invoices MUST be written in ONE transaction (see the atomicity requirement
  in `gr-balance-sync`); a partial write is what makes an unexpected side effect dangerous.
- Concurrent callers for the same client MUST collapse into a single flight, so the webhook and
  the ficha cannot race and seal an older snapshot as fresh.

#### Scenario: a client who has paid off gets their mirrored invoices cleared
- GIVEN a stale client whose GR payload now reports `debt: "0.00"` with an empty `invoices[]`
- WHEN the bot resolves `cliente.saldo` and the refresh succeeds
- THEN the balance is stored as `0` AND the client's GR-sourced mirrored invoices are removed
  (the authoritative zero-debt case), in a single transaction
- AND the bot answers "al día"

#### Scenario: a non-authoritative payload leaves the invoice mirror untouched
- GIVEN GR reports `amount > 0` but returns NO itemized invoices (schema drift / partial payload)
- WHEN the refresh runs
- THEN the balance is written and the invoice mirror is NOT touched
