# gigared-config Specification

## Purpose

Manage the GigaredConfig singleton (API key, base URL) and the `gigared-integration` feature flag. All Gigared routes return 503 when unconfigured or when the flag is OFF.

## Requirements

### Requirement: GigaredConfig Singleton

The system MUST maintain a single-row `GigaredConfig` record with fields `apiKey TEXT`, `baseUrl TEXT DEFAULT 'https://partners.gigaredsa.com.ar/api/v1'`, and `updatedAt TIMESTAMP`.

The system MUST create the row via upsert on first access (id = `'singleton'`). An empty `apiKey` string means unconfigured.

#### Scenario: Config row does not exist yet

- GIVEN no row exists in `GigaredConfig`
- WHEN `GetGigaredConfig` use case is called
- THEN the system returns defaults: `configured: false`, `baseUrl: 'https://partners.gigaredsa.com.ar/api/v1'`, `updatedAt: null`

#### Scenario: Config row exists with apiKey set (aligned to as-built)

- GIVEN a row exists with `apiKey = 'abcdef1234'`
- WHEN `GetGigaredConfig` use case is called
- THEN the system returns `{ configured: true, apiKeyLast4: '1234', baseUrl: <value>, enabled: <bool>, updatedAt: <ts> }`
- AND the full `apiKey` value MUST NOT appear in the response payload

### Requirement: GET /api/gigared/config

`GET /api/gigared/config` MUST require permission `tv.manage`.

The endpoint MUST return `{ configured: bool, apiKeyLast4: string | null, baseUrl: string, enabled: bool, updatedAt: string | null }` (aligned to as-built — the masked tail field is `apiKeyLast4`, not `last4`).

The `apiKey` field MUST NEVER be included in the response. The audit middleware also masks `apiKey`/`api_key` to `***` (the `apiKeyLast4` preview is public and NOT masked).

#### Scenario: Authenticated user with tv.manage fetches config (aligned to as-built)

- GIVEN the user has `tv.manage` and `apiKey = 'supersecretKEY99'` is stored
- WHEN `GET /api/gigared/config`
- THEN response 200 with `{ configured: true, apiKeyLast4: 'EY99', baseUrl: '...', enabled: <bool>, updatedAt: '...' }`
- AND no `apiKey` field in response body

#### Scenario: User without tv.manage

- GIVEN the user lacks `tv.manage`
- WHEN `GET /api/gigared/config`
- THEN response 403

### Requirement: PUT /api/gigared/config

`PUT /api/gigared/config` MUST require permission `tv.manage`.

The body MUST accept `{ apiKey?: string, baseUrl?: string, enabled?: boolean }` (aligned to as-built — `enabled` toggles the `gigared-integration` feature flag). Omitting a field MUST leave its current value unchanged. `apiKey: ''` clears the key (unconfigured).

#### Scenario: Update apiKey only (aligned to as-built)

- GIVEN the user has `tv.manage`
- WHEN `PUT /api/gigared/config` with `{ apiKey: 'newkey' }`
- THEN response 200 with masked config (`configured: true, apiKeyLast4: 'wkey'`)
- AND `baseUrl` is unchanged
- AND the resulting `AuditEvent.beforeJson` MUST mask `apiKey` to `***` (C1 — the key is never persisted in clear)

#### Scenario: Update with empty body (no-op)

- GIVEN the user has `tv.manage`
- WHEN `PUT /api/gigared/config` with `{}`
- THEN response 200, no fields changed

### Requirement: Readiness & Probe Gating (aligned to as-built — M1)

The API key is required ALWAYS: when `apiKey` is empty, every gated route (including the probe) MUST return 503 with `{ code: 'GIGARED_NOT_CONFIGURED' }`.

The `gigared-integration` feature flag gates ALL routes under `/api/gigared/*` EXCEPT three: `GET /api/gigared/config`, `PUT /api/gigared/config`, and the probe `GET /api/gigared/summary`. The probe is the "test connection" path: with the flag OFF but a key set it MUST answer 200 so the operator can validate the key BEFORE enabling the integration.

Config routes (`GET/PUT /api/gigared/config`) MUST remain accessible regardless of flag or key status.

#### Scenario: Flag is OFF, accessing a non-probe route

- GIVEN `gigared-integration` flag is OFF and `apiKey` is set
- WHEN `GET /api/gigared/accounts`
- THEN response 503 `{ code: 'GIGARED_NOT_CONFIGURED' }` (the flag gates it)

#### Scenario: Probe exempt from the flag (aligned to as-built — M1)

- GIVEN flag is OFF and `apiKey` is set
- WHEN `GET /api/gigared/summary`
- THEN response 200 (the probe validates the key without the flag)

#### Scenario: Probe still requires the key (aligned to as-built — M1)

- GIVEN flag is OFF and `apiKey = ''`
- WHEN `GET /api/gigared/summary`
- THEN response 503 `{ code: 'GIGARED_NOT_CONFIGURED' }` (key required always)

#### Scenario: Flag is ON but apiKey is empty

- GIVEN flag is ON and `apiKey = ''`
- WHEN `GET /api/gigared/accounts`
- THEN response 503 `{ code: 'GIGARED_NOT_CONFIGURED' }`

#### Scenario: Config route accessible when flag is OFF

- GIVEN flag is OFF
- WHEN `GET /api/gigared/config` (with tv.manage)
- THEN response 200 (NOT 503)

### Requirement: DB Migration

The migration MUST be additive (no BEGIN/COMMIT wrapping). It MUST create:
- Table `GigaredConfig` with singleton row pattern
- `RbacModule`: `tv` with label `TV / Gigared`
- `RbacPermission`: `tv:read`, `tv:write`, `tv:manage`
- `RbacRolePermission` grants to `super_admin` (all 3) and `administrador` (all 3)
- `FeatureFlag`: `gigared-integration` with `enabled = false`

#### Scenario: Fresh migration on empty DB

- GIVEN a clean DB
- WHEN migration runs
- THEN `GigaredConfig` table exists, RBAC module `tv` and its 3 permissions exist, flag `gigared-integration` is OFF
