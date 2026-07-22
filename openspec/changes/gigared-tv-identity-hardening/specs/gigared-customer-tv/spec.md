# Delta for gigared-customer-tv

## MODIFIED Requirements

### Requirement: POST /api/gigared/customers/:customerId/register

`POST .../register` MUST require permission `tv.write`. Body: `{ firstName, lastName, email, contractId,
sendActivationEmail }`. `cic` and `password` in the body (if present) MUST be ignored — the CIC is
auto-assigned from the pool and the password is derived server-side.
(Previously: body accepted a free-typed `cic`; password was randomly generated; response was a fixed 201
with NO partial-success signal and NO protection against a poisoned pool CIC.)

**Root cause context (2026-07-22, confirmed by forensics — engram `gigared/root-cause-cic-envenenado`):**
the incident account was NOT the result of an operator on the wrong page. `CancelTv` runs `renewCic`, which
moves a customer's `internal_id` onto a NEW CIC that returns to the `unregistered` pool STILL CARRYING that
`internal_id` (the partner rejects an empty `internal_id`, #72, so it can never be cleared). The register
picked that poisoned CIC AT RANDOM and its `internal_id` bled through when `setInternalId` failed. This
requirement closes that hole.

The system MUST:

1. Resolve `contractId` → its owning customer (`contract.clientId === customerId`, else 404
   `CONTRACT_NOT_FOUND`) and derive the deterministic email/password from the contract's `grContratoId`
   (existing #115/#118 behavior, unchanged).
2. If the customer's TV is cancelled, increment `tvActivationSeq` and mint a fresh `internal_id`/email
   BEFORE any partner write (existing #81 guard — regression guard, behavior UNCHANGED by this delta).
   Note: this guard was NOT the incident mechanism (the incident customer was a fresh, non-cancelled `alta`
   at `seq=0`); it stays because it is correct on its own.
3. **Probe before writing** (idempotency): call `getAccountByInternalId(currentInternalId)`.
   - Found (already stamped with MY `internal_id`) → skip pool-pick/`register`/`activate`/`setInternalId`;
     run ONLY the local reconcile (idempotent completion, `recovered: true`).
   - Not found (404) → proceed to the pool-pick guard (step 4).
4. **Pool anti-poisoning (the real fix)**: fetch the pool via `listAccounts({ status: 'unregistered' })`.
   The pool listing ALREADY carries each entry's `internalId`, so filtering is a pure in-memory operation
   with NO extra partner calls.
   - Empty pool → 422 `NO_CIC_AVAILABLE` (unchanged).
   - Keep ONLY entries whose `internalId` is empty/null (a clean CIC never touched by a prior owner).
     Discard every entry that carries an `internal_id` (foreign OR own-old) — a poisoned CIC recycled by a
     previous `CancelTv`. Pick the CIC from the CLEAN subset.
   - Clean subset empty (every pooled CIC is poisoned) → 422 `TV_POOL_POISONED` (NEW; same family as
     `NO_CIC_AVAILABLE`), carrying the poisoned count. **No partner write occurs.**
5. Proceed `register → activate → setInternalId` (happy path, order unchanged; a Gigared write is never
   reverted). If `register` rejects with `GIGARED_REJECTED` (email duplicate), probe
   `listAccounts({ email: derivedEmail })` and recover WITHOUT any `unlink`:
   - match with empty `internalId` → MY orphan (register ran, stamp didn't) → resume
     `activate → setInternalId → getAccountByInternalId → reconcile`. With the step-4 filter, every NEW
     orphan is created on a clean CIC, so its `internalId` is empty → this is the expected recovery branch.
   - match with `internalId` === mine → same as step 3's found-branch (complete local only).
   - match with `internalId` belonging to someone else → throw **`TV_EMAIL_OWNED_BY_OTHER`** (409, NEW —
     distinct from `CIC_ALREADY_LINKED`); `setInternalId` MUST NOT be called. This also covers the
     historical poisoned-orphan (email is MINE but `internal_id` is a prior owner's): refusing to auto-touch
     an account bound to a foreign `internal_id` is the SAFE choice — the operator resolves via link/transfer.
   - no match by email → re-throw the original `GIGARED_REJECTED` (422).
6. **Post-stamp verification (the real fix, part 2)**: after `setInternalId`, `getAccountByInternalId(myInternalId)`
   MUST resolve to the CIC just stamped. If the readback 404s or returns a DIFFERENT CIC (the append-only
   `internal_id` did not bind to my CIC), throw **`TV_IDENTITY_UNVERIFIED`** (503, NEW) and do NOT write a
   partial local row — a retry's step-3 probe / step-5 recovery completes it idempotently.
7. Respond with:
   ```
   { account, partnerCreated: boolean, localReconciled: 'synced'|'failed',
     credentialsPersisted: boolean, recovered: boolean }
   ```
   `partial = !partnerCreated || localReconciled === 'failed'` → **207**; else **201** (happy path unchanged).
   `recovered` is observability-only (true when this execution completed/resumed a pre-existing partner
   account) — it does NOT gate the status code.

Note (documented, NOT fixed by this change): `LinkCustomerToCic` does not carry step 2's seq-mint guard — it
uses `customer.tvActivationSeq` as-is. Forensics proved this did NOT cause the incident (no link ran before
the manual fix). Known gap, out of scope here.

#### Scenario: Successful registration, happy path (clean pool)

- GIVEN a valid contract, its owning customer, a deterministic email not yet used, and a pool with at least
  one CLEAN CIC (empty `internalId`)
- WHEN `POST .../register { firstName, lastName, email, contractId, sendActivationEmail }`
- THEN a clean CIC is picked; register→activate→setInternalId→getAccountByInternalId each run once; the
  post-stamp readback resolves to that CIC; local reconcile succeeds
- AND response 201 `{ partnerCreated: true, localReconciled: 'synced', recovered: false }`

#### Scenario: Pool has poisoned + clean CICs — the clean one is chosen

- GIVEN the `unregistered` pool contains one CIC carrying a foreign `internal_id` (poisoned by a prior
  `CancelTv` recycle) and one CIC with an empty `internalId`
- WHEN `POST .../register`
- THEN the poisoned CIC is skipped and the clean CIC is used for register/activate/setInternalId
- AND no foreign `internal_id` ever reaches the new account

#### Scenario: Entire pool is poisoned — typed error, no partner write

- GIVEN every CIC in the `unregistered` pool carries a non-empty `internal_id`
- WHEN `POST .../register`
- THEN response 422 `{ code: 'TV_POOL_POISONED' }` and NO partner write (`register`/`activate`/
  `setInternalId`) is attempted

#### Scenario: Post-stamp verification fails — typed error, no partial local row

- GIVEN register→activate→setInternalId all return OK, but `getAccountByInternalId(myInternalId)` 404s or
  resolves to a DIFFERENT CIC than the one stamped
- WHEN `POST .../register`
- THEN response 503 `{ code: 'TV_IDENTITY_UNVERIFIED' }`; NO local `ContractService` row is written; a retry
  recovers idempotently via the probe/recovery path

#### Scenario: Retry after partner-created + local-none (idempotent, no duplicate)

- GIVEN a prior attempt already stamped the partner account with MY current `internal_id`, but local
  reconcile never ran (crashed mid-sequence)
- WHEN `POST .../register` is retried with the same `contractId`
- THEN the step-3 probe finds MINE → pool-pick/`register`/`activate`/`setInternalId` are NOT called again →
  only local reconcile runs
- AND response has `recovered: true`, `partnerCreated: true` (201 if reconcile now succeeds, 207 if it fails)

#### Scenario: Retry after register-only orphan on a clean CIC (email dup, mine)

- GIVEN a prior attempt ran `register` on a CLEAN CIC but crashed before `setInternalId` (account exists,
  `internalId` empty)
- WHEN `POST .../register` is retried
- THEN `register` rejects on email-dup → the email probe finds the orphan with empty `internalId` → resumes
  `activate→setInternalId→getAccountByInternalId→reconcile`
- AND response has `recovered: true`

#### Scenario: Email owned by another customer (distinguishable 409)

- GIVEN the deterministic email already belongs to an account whose `internal_id` is NOT mine (a genuine
  collision OR a historical poisoned-orphan)
- WHEN `POST .../register`
- THEN response 409 `{ code: 'TV_EMAIL_OWNED_BY_OTHER' }`; `setInternalId` is NEVER called; no local row

#### Scenario: Partner OK, local reconcile fails (partial success)

- GIVEN register→activate→setInternalId→getAccountByInternalId all succeed (readback verified) but the local
  `ContractService` reconcile throws
- WHEN `POST .../register`
- THEN response 207 `{ account, partnerCreated: true, localReconciled: 'failed', credentialsPersisted: false }`

#### Scenario: Cancelled TV mints a fresh identity (regression guard, unchanged)

- GIVEN a customer with `tvCancelledAt` set and `tvActivationSeq = 0`, registering FRESH (no prior partial)
- WHEN `POST .../register`
- THEN `tvActivationSeq` increments BEFORE any partner write and `internal_id`/email use `seq+1` — EXISTING
  behavior (guard #81), unchanged by this delta

### Requirement: TV identity is BE-authoritative (OPTIONAL hardening — not incident-causal)

> **Scope note**: This requirement is an OPTIONAL hardening batch, applied LAST, and MAY be deferred out of
> v1. Forensics proved the body name was NOT the incident vector (the operator was on the correct page with
> the correct name). It removes a *theoretical* corruption surface, not the confirmed root cause. If deferred,
> the register endpoint keeps passing `firstName`/`lastName` from the body to the partner (current behavior),
> which does NOT reopen the incident.

When this hardening ships, the system MUST derive `firstName`/`lastName` from the customer resolved via
`contractId`, NEVER from the request body, and MUST feed that derived `lastName` (not the body's) into
`deterministicTvEmail`. The name is split with the **APELLIDO-first** convention (first token = `lastName`,
the rest = `firstName`), verified against production data and mirroring the existing FE `splitName` helper.
Body `firstName`/`lastName` (if still sent during the deploy window) MUST be ignored.

#### Scenario: Body name differs from the resolved customer (identity corruption vector)

- GIVEN the hardening is shipped, and the body carries `firstName`/`lastName` for a DIFFERENT person than the
  customer resolved via `contractId`
- WHEN `POST .../register`
- THEN the account is created with the resolved customer's name (APELLIDO-first split), NEVER the body's; the
  deterministic email also derives from the resolved `lastName`
