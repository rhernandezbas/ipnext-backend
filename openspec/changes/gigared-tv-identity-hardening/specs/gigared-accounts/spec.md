# Delta for gigared-accounts

## MODIFIED Requirements

### Requirement: GET /api/gigared/accounts

`GET /api/gigared/accounts` MUST require permission `tv.read`.

Accepted query params (unchanged): `status` (`registered`|`unregistered`), `email`, `account_id`,
`pagination_limit`, `pagination_offset`.

The system MUST proxy to `GET /accounts` on Gigared, then resolve each returned account's `clientId`
**local-first**:

1. Collect the `cic` of every account in the response and resolve the active `TV` catalog entry ONCE.
2. Run **exactly one** batch query against `ContractServiceRepository`
   (`findActiveTvOwnersByCics(catalogId, cics[])`, which JOINs the contract so the `clientId` comes back
   without a per-row lookup) for managed active rows of the WHOLE page — a per-account query, or a
   prefix scan that then resolves `clientId` row-by-row, is a bug (N+1 FORBIDDEN).
3. Match each account's `cic` against the batch result (`cicFromNotes`, exact match — the prefix "CIC 12"
   must NOT over-match "CIC 123"; first row by `createdAt` wins) and take that row's `clientId`. When a
   match exists, this is the AUTHORITATIVE `clientId`.
4. No local match → fall back to the alias-derived `clientId`
   (`internalId.replace(/-\d+$/, '')`, current behavior). No extra "resolved-locally" indicator in v1.

The response MUST remain `{ accounts: GigaredAccount[] }` (no envelope change).
(Previously: `clientId` was ALWAYS derived from the partner's primary `internal_id` alias, which is
append-only and keeps reporting the ORIGINAL owner forever — even after a successful transfer.)

#### Scenario: Successful list

- GIVEN the user has `tv.read`, flag is ON, apiKey is set
- WHEN `GET /api/gigared/accounts?pagination_limit=20&pagination_offset=0`
- THEN response 200 with `{ accounts: [...] }`, each item conforming to `GigaredAccount`

#### Scenario: Filter by email

- GIVEN `email=test@example.com` is passed
- WHEN `GET /api/gigared/accounts?email=test@example.com`
- THEN only accounts matching that email are returned

#### Scenario: Filter by status

- GIVEN `status=registered` is passed
- WHEN `GET /api/gigared/accounts?status=registered`
- THEN only registered accounts are returned

#### Scenario: Upstream 429

- GIVEN Gigared API returns 429 with `Retry-After: 2`
- WHEN `GET /api/gigared/accounts`
- THEN the adapter retries up to `maxRateLimitRetries`; exhausted → response 503 `{ code: 'GIGARED_UNAVAILABLE' }`

#### Scenario: Upstream 5xx

- GIVEN Gigared API returns 502
- WHEN `GET /api/gigared/accounts`
- THEN response 503 `{ code: 'GIGARED_UNAVAILABLE' }`

#### Scenario: Upstream 401/403

- GIVEN Gigared API returns 401 or 403 (bad/missing key)
- WHEN `GET /api/gigared/accounts`
- THEN response 502 `{ code: 'GIGARED_AUTH_FAILED' }`

#### Scenario: User lacks tv.read

- GIVEN user does not have `tv.read`
- WHEN `GET /api/gigared/accounts`
- THEN response 403

#### Scenario: Transferred account with a local link shows the NEW owner

- GIVEN an account whose partner alias still resolves to the OLD titular, but a local managed
  `ContractService` row exists for its `cic` under the NEW customer's contract
- WHEN `GET /api/gigared/accounts`
- THEN that item's `clientId` is the NEW customer's — NOT the alias-derived old one

#### Scenario: Account without a local row falls back to the partner alias

- GIVEN an account whose `cic` matches NO managed `ContractService` row (never reconciled locally)
- WHEN `GET /api/gigared/accounts`
- THEN that item's `clientId` is the alias-derived value (unchanged fallback behavior)

#### Scenario: Mixed batch of N accounts — no N+1

- GIVEN a response of N accounts, some with a local match and some without
- WHEN `GET /api/gigared/accounts`
- THEN exactly ONE query is issued against `ContractServiceRepository` for the whole batch (never one per
  account), and each item resolves independently — local-match items get the local `clientId`, others fall
  back to the alias-derived value
