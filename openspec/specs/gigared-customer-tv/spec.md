# gigared-customer-tv Specification

## Purpose

Per-customer TV activation: link or register a Gigared account, add/remove TV services (with local ContractService), and toggle OTT. The `internal_id = customer.id` (UUID) is the binding key stored in Gigared.

## Requirements

### Requirement: GET /api/gigared/customers/:customerId/account (aligned to as-built)

`GET .../account` MUST require permission `tv.read`.

The system MUST call `GET /accounts/{customerId}?use_internal_id=true`. As-built: a Gigared 404 is NOT an error — the customer simply has no TV link yet, so the endpoint responds **200 `{ linked: false, account: null }`** (NOT 404 `TV_NOT_LINKED`). A linked customer responds 200 `{ linked: true, account: <GigaredAccountDTO> }`.

The frozen upstream error codes are: `GIGARED_NOT_CONFIGURED` (503), `GIGARED_UNAVAILABLE` (503), `GIGARED_AUTH_FAILED` (502), `GIGARED_NOT_FOUND` (404), `GIGARED_REJECTED` (422) — there is no `GIGARED_UPSTREAM_ERROR`.

#### Scenario: Customer has linked Gigared account (aligned to as-built)

- GIVEN `customerId` has an associated Gigared account
- WHEN `GET /api/gigared/customers/:customerId/account`
- THEN response 200 with `{ linked: true, account: <GigaredAccountDTO> }`

#### Scenario: Customer not linked in Gigared (aligned to as-built)

- GIVEN Gigared returns 404 for the `use_internal_id=true` lookup
- WHEN `GET .../account`
- THEN response **200 `{ linked: false, account: null }`** (the 404 is swallowed, NOT propagated)

#### Scenario: Gigared API unavailable (aligned to as-built)

- GIVEN Gigared is unreachable
- WHEN `GET .../account`
- THEN response 503 `{ code: 'GIGARED_UNAVAILABLE' }`

#### Scenario: Unknown local customer

- GIVEN `customerId` does not exist locally
- WHEN `GET .../account`
- THEN response 404 `{ code: 'CLIENT_NOT_FOUND' }`

### Requirement: POST /api/gigared/customers/:customerId/link (aligned to as-built — C2)

`POST .../link` MUST require permission `tv.write`. Body: `{ cic: string }`.

The system MUST (C2 — `CIC_ALREADY_LINKED` is now implemented; it was previously a false-positive task):
1. Call `GET /accounts/{cic}` by CIC (NO `use_internal_id`) to resolve the partner.
2. If the partner 404s upstream → 404 `{ code: 'CIC_NOT_FOUND' }` (a CIC-specific code, NOT the generic `GIGARED_NOT_FOUND`).
3. If the partner's `internal_id` is non-empty and DIFFERENT from `customerId` → 409 `{ code: 'CIC_ALREADY_LINKED' }` (carries `linkedInternalId`). No `PATCH` is performed.
4. If the partner's `internal_id` EQUALS `customerId` → idempotent OK (no `PATCH`), return 200 with the partner account.
5. Otherwise (`internal_id` empty) → `PATCH /accounts/{cic}/internal_id` with `{ internal_id: customerId }`, then read the account back by internal_id.
6. Return 200 with the resulting `GigaredAccountDTO`.

#### Scenario: Valid CIC, not yet linked (free)

- GIVEN `cic` exists in Gigared with an empty internal_id
- WHEN `POST .../link { cic: '0000001234' }`
- THEN Gigared `PATCH` is called, response 200 with account data (`internalId = customerId`)

#### Scenario: CIC already linked to a different customer (aligned to as-built — C2)

- GIVEN `cic` exists in Gigared with `internal_id = 'cust-OTHER'`
- WHEN `POST .../link { cic: '0000001234' }`
- THEN response 409 `{ code: 'CIC_ALREADY_LINKED' }` and NO `PATCH` is performed

#### Scenario: CIC already linked to THIS customer → idempotent (aligned to as-built — C2)

- GIVEN `cic` exists in Gigared with `internal_id = customerId`
- WHEN `POST .../link { cic: '0000001234' }`
- THEN response 200 with the account and NO `PATCH` is performed

#### Scenario: CIC does not exist in Gigared (aligned to as-built — C2)

- GIVEN Gigared returns 404 for `GET /accounts/{cic}`
- WHEN `POST .../link { cic: 'XXXX' }`
- THEN response 404 `{ code: 'CIC_NOT_FOUND' }` (specific, not `GIGARED_NOT_FOUND`)

### Requirement: POST /api/gigared/customers/:customerId/register

`POST .../register` MUST require permission `tv.write`. Body: `{ email, firstName, lastName, cic }`.

The system MUST:
1. Generate a random password server-side; MUST NOT persist it.
2. Call `POST /accounts/register` with `send_activation_email: true`.
3. Call `POST /accounts/activate` to activate the account.
4. Set `internal_id = customerId` via `PATCH /accounts/{cic}/internal_id`.
5. Return 201 with `GigaredAccountDTO`.

#### Scenario: Successful registration and activation

- GIVEN all fields valid, email not registered in Gigared
- WHEN `POST .../register { email, firstName, lastName, cic }`
- THEN register + activate + set internal_id are called in order
- AND response 201 with account data
- AND the generated password MUST NOT appear in the response

#### Scenario: Email already registered in Gigared (aligned to as-built)

- GIVEN Gigared rejects the register call (RFC 9457 4xx)
- WHEN `POST .../register { email: 'existing@x.com', ... }`
- THEN response 422 `{ code: 'GIGARED_REJECTED', title, detail }` (there is no dedicated `GIGARED_ACCOUNT_EXISTS` code; the upstream rejection surfaces as `GIGARED_REJECTED`)

### Requirement: POST /api/gigared/customers/:customerId/services (aligned to as-built)

`POST .../services` MUST require permission `tv.write`. Body: `{ serviceId: string, contractId: string }`.

The system MUST follow this order (guards pinned): customer exists (else 404 `CLIENT_NOT_FOUND`) → contract exists (else 404 `CONTRACT_NOT_FOUND`) → active `TV` catalog entry (else 422 `TV_CATALOG_MISSING`) → then:
1. Call Gigared `POST /services/{customerId}?use_internal_id=true` to add the service. If Gigared rejects BUT the account already carries `serviceId`, that is idempotent success — continue (D7); otherwise propagate the error.
2. Reconcile the local TV slot (`reconcileTvContractService`): read the account, then **upsert ONE** `ContractService` on the UNIQUE `(contractId, TV)` pair with `notes = "CIC {cic} · {names joined by ' · '}"`, status `active`. A second service updates the SAME row (no duplicate).
3. If reconcile throws → respond 207 `{ gigared: 'ok', local: 'failed', localError: <reason> }`. The Gigared action MUST NOT be reverted.

As-built corrections: the contract guard is `CONTRACT_NOT_FOUND` (404), NOT `INVALID_CONTRACT` (400). There is no separate `already_exists` code — a repeated add upserts the single managed row. The 207 detail field is `localError` (carried by `local: 'failed'`).

#### Scenario: Both Gigared and local succeed

- GIVEN `serviceId` valid, `contractId` exists, active TV catalog, Gigared accepts
- WHEN `POST .../services { serviceId, contractId }`
- THEN Gigared service added, ContractService upserted with notes `"CIC ... · ..."`, status `active`
- AND response 200 `{ gigared: 'ok', local: 'ok' }`

#### Scenario: Gigared succeeds but local reconcile fails (aligned to as-built)

- GIVEN Gigared add service succeeds, but the DB write throws
- WHEN `POST .../services`
- THEN response 207 `{ gigared: 'ok', local: 'failed', localError: '...' }`
- AND Gigared service is NOT rolled back

#### Scenario: Second service on the same contract (aligned to as-built)

- GIVEN a managed TV row already exists for that contract
- WHEN `POST .../services` for a different `serviceId`
- THEN the SAME row is updated (notes now list both services); response 200 (no duplicate, no `already_exists` code)

#### Scenario: Idempotent re-add already present in Gigared (D7)

- GIVEN Gigared rejects the add but the account ALREADY carries `serviceId`
- WHEN `POST .../services`
- THEN the rejection is treated as success; reconcile runs; response 200

#### Scenario: contract does not exist (aligned to as-built)

- GIVEN `contractId` does not reference an existing contract
- WHEN `POST .../services`
- THEN response 404 `{ code: 'CONTRACT_NOT_FOUND' }`

#### Scenario: TV catalog missing/inactive

- GIVEN there is no active `TV` entry in the ServiceCatalog
- WHEN `POST .../services`
- THEN response 422 `{ code: 'TV_CATALOG_MISSING' }` (before touching Gigared)

### Requirement: DELETE /api/gigared/customers/:customerId/services/:serviceId (aligned to as-built — H1+H2)

`DELETE .../services/:serviceId?contractId=` MUST require permission `tv.write`.

The system MUST:
1. Call Gigared `DELETE /services/{customerId}/{serviceId}?use_internal_id=true` to remove the service. If step 1 fails → propagate the error; local record unchanged.
2. Reconcile the local TV slot. **Ownership (H2):** reconcile ONLY ever touches the Gigared-managed row — the one whose `notes` start with the prefix `"CIC "`. A TV `ContractService` created by hand via the #42 UI (notes null or anything not starting with `"CIC "`) is NEVER inactivated or overwritten.
3. **Inactivate, never delete (H1):** when the customer ends up with NO Gigared services, reconcile sets the managed row's `status = 'inactive'` via `update` (PATCH). It MUST NOT delete the row — history is preserved and the slot can be re-activated by the next add. When services remain, the managed row stays `active` with refreshed notes.
4. If reconcile throws → respond 207 `{ gigared: 'ok', local: 'failed', localError }`.

#### Scenario: Removing the last service inactivates the managed row (aligned to as-built — H1)

- GIVEN the customer's only TV service is removed and a managed row (`notes` starts with `"CIC "`) exists
- WHEN `DELETE .../services/:serviceId?contractId=`
- THEN Gigared removal is called, the managed row STILL exists with `status = 'inactive'` (NOT deleted)
- AND response 200 `{ gigared: 'ok', local: 'ok' }`

#### Scenario: A manually-created TV row is never touched (aligned to as-built — H2)

- GIVEN the `(contract, TV)` slot holds a row whose notes do NOT start with `"CIC "` (manual #42 UI)
- WHEN `DELETE .../services/:serviceId?contractId=` and the account ends with no services
- THEN that row is left UNTOUCHED (`status` stays `active`, notes unchanged); reconcile does not delete or inactivate it

#### Scenario: Removing one of several keeps the managed row active

- GIVEN the customer keeps other Gigared services after the removal
- WHEN `DELETE .../services/:serviceId?contractId=`
- THEN the managed row stays `active` with refreshed `"CIC ... · ..."` notes

#### Scenario: Gigared removal fails

- GIVEN Gigared returns an error on DELETE
- WHEN `DELETE .../services/:serviceId`
- THEN the response propagates the Gigared error and the local ContractService is UNCHANGED

### Requirement: PUT /api/gigared/customers/:customerId/ott

`PUT .../ott` MUST require permission `tv.write`. Body: `{ enabled: boolean }`.

The system MUST call `PUT /ott/{customerId}/enable` or `/disable` based on `enabled` value, using `?use_internal_id=true`.

#### Scenario: Enable OTT

- GIVEN customer has linked account
- WHEN `PUT .../ott { enabled: true }`
- THEN `PUT /ott/{customerId}/enable?use_internal_id=true` is called
- AND response 200

#### Scenario: Disable OTT

- GIVEN customer has linked account
- WHEN `PUT .../ott { enabled: false }`
- THEN `PUT /ott/{customerId}/disable?use_internal_id=true` is called
- AND response 200

#### Scenario: Customer not linked in Gigared (aligned to as-built)

- GIVEN no Gigared account exists for this `customerId` (the upstream call 404s)
- WHEN `PUT .../ott { enabled: true }`
- THEN response 404 `{ code: 'GIGARED_NOT_FOUND' }` (the upstream 404 propagates; there is no `TV_NOT_LINKED` code)

#### Scenario: Unknown local customer

- GIVEN `customerId` does not exist locally
- WHEN `PUT .../ott { enabled: true }`
- THEN response 404 `{ code: 'CLIENT_NOT_FOUND' }`
