# gigared-accounts Specification

## Purpose

Proxy on-demand access to the Gigared Partners API for listing accounts and fetching summary data. The system acts as an authenticated proxy: adds X-API-Key, maps RFC 9457 errors, enforces RBAC.

## DTO: GigaredAccount (aligned to as-built)

```
{
  cic: string
  gigaredId: string | null
  email: string | null
  firstName: string | null
  lastName: string | null
  registrationDate: string | null   // as returned by Gigared (e.g. "19/01/2026")
  services: { id: string; name: string }[]   // no `status` field
  internalId: string | null
  ott: {
    id: string
    stationaryLicenses: number
    mobileLicenses: number
    registeredDevices: number
    status: string | null
  } | null
}
```

## DTO: GigaredSummary (aligned to as-built)

```
{
  accounts: { registered: number; unregistered: number; total: number }
  services: { id: string; name: string; qtyPurchased: number; qtyUsed: number; qtyAvailable: number }[]
}
```

## Requirements

### Requirement: GET /api/gigared/accounts

`GET /api/gigared/accounts` MUST require permission `tv.read`.

Accepted query params (aligned to as-built): `status` (`registered`|`unregistered`), `email`, `account_id`, `pagination_limit`, `pagination_offset`.

The system MUST proxy the request to `GET /accounts` on the Gigared API, passing filters and pagination. The response MUST be `{ accounts: GigaredAccount[] }` (aligned to as-built — there is no `total`/`limit`/`offset` envelope).

#### Scenario: Successful list (aligned to as-built)

- GIVEN the user has `tv.read`, flag is ON, apiKey is set
- WHEN `GET /api/gigared/accounts?pagination_limit=20&pagination_offset=0`
- THEN response 200 with `{ accounts: [...] }`
- AND each item conforms to `GigaredAccount`

#### Scenario: Filter by email

- GIVEN `email=test@example.com` is passed
- WHEN `GET /api/gigared/accounts?email=test@example.com`
- THEN only accounts matching that email are returned

#### Scenario: Filter by status

- GIVEN `status=registered` is passed
- WHEN `GET /api/gigared/accounts?status=registered`
- THEN only registered accounts are returned

#### Scenario: Upstream 429 (aligned to as-built)

- GIVEN Gigared API returns 429 with `Retry-After: 2`
- WHEN `GET /api/gigared/accounts`
- THEN the adapter retries up to `maxRateLimitRetries` times with Retry-After / exponential backoff
- AND if all retries are exhausted, response 503 `{ code: 'GIGARED_UNAVAILABLE' }` (a rate-limit outage, not a 429 passthrough)

#### Scenario: Upstream 5xx (aligned to as-built)

- GIVEN Gigared API returns 502
- WHEN `GET /api/gigared/accounts`
- THEN response 503 `{ code: 'GIGARED_UNAVAILABLE' }`

#### Scenario: Upstream 401/403 (aligned to as-built)

- GIVEN Gigared API returns 401 or 403 (bad/missing key)
- WHEN `GET /api/gigared/accounts`
- THEN response 502 `{ code: 'GIGARED_AUTH_FAILED' }`

#### Scenario: User lacks tv.read

- GIVEN user does not have `tv.read`
- WHEN `GET /api/gigared/accounts`
- THEN response 403

### Requirement: GET /api/gigared/summary

`GET /api/gigared/summary` MUST require permission `tv.read`.

The system MUST proxy to `GET /partners/summary` and return `GigaredSummary`. `GET /summary` is the probe endpoint (M1) — flag-exempt, key-required.

#### Scenario: Successful summary fetch (aligned to as-built)

- GIVEN apiKey set, user has `tv.read`
- WHEN `GET /api/gigared/summary`
- THEN response 200 with `{ accounts: { registered, unregistered, total }, services: [...] }`

#### Scenario: Upstream unavailable (aligned to as-built)

- GIVEN Gigared API is unreachable (timeout/network)
- WHEN `GET /api/gigared/summary`
- THEN response 503 `{ code: 'GIGARED_UNAVAILABLE' }` (distinct from `GIGARED_NOT_CONFIGURED`)

### Requirement: Error Mapping (aligned to as-built)

The adapter MUST map Gigared transport/RFC 9457 error responses to domain errors:
- `401` / `403` → `GigaredAuthError` (code `GIGARED_AUTH_FAILED`)
- `404` → `GigaredNotFoundError` (code `GIGARED_NOT_FOUND`)
- `429` retries exhausted → `GigaredUnavailableError` (treated as an outage)
- other `4xx` → `GigaredRejectedError` (carries `title` + `detail`)
- `5xx` / network → `GigaredUnavailableError`

Routes MUST translate these to their pinned HTTP statuses: `GIGARED_NOT_CONFIGURED` → 503, `GIGARED_UNAVAILABLE` → 503, `GIGARED_AUTH_FAILED` → 502, `GIGARED_NOT_FOUND` → 404, `GIGARED_REJECTED` → **422** (NOT 424), `TV_CATALOG_MISSING` → 422, plus the link-specific `CIC_NOT_FOUND` → 404 and `CIC_ALREADY_LINKED` → 409 (C2). There is no `GIGARED_UPSTREAM_ERROR` code.

#### Scenario: Adapter receives RFC 9457 4xx (aligned to as-built)

- GIVEN Gigared returns a non-404 4xx `{ status, title, detail }`
- WHEN the adapter processes the response
- THEN it throws `GigaredRejectedError` carrying `title` + `detail` → route responds 422 `GIGARED_REJECTED`

#### Scenario: Adapter receives 404 (aligned to as-built)

- GIVEN Gigared returns `404`
- WHEN the adapter processes the response
- THEN it throws `GigaredNotFoundError` (code `GIGARED_NOT_FOUND`) → route 404
