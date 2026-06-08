# iclass-closure-config Specification

**Capability**: `iclass-closure-config`
**Type**: New (no prior spec)
**Layer**: Domain port + Application use-cases + Infrastructure routes + Scheduler/bootstrap
**Routes**:
`GET /api/admin/iclass/closure/config` (RBAC `iclass:manage`),
`PUT /api/admin/iclass/closure/config` (RBAC `iclass:manage`)

---

## Purpose

Provide a persisted, operator-tunable config store for the IClass closure-loop and task-autocomplete
scheduler intervals, exposed through RBAC-guarded HTTP endpoints and consumed by both bootstraps at
startup. Replaces hardcoded `DEFAULT_INTERVAL_MS` constants with DB-backed values that can be changed
without a code redeploy (a server restart is still required for the change to take effect).

---

## Requirements

### Requirement: Config store shape

The system MUST persist a single config record (`id = "singleton"`) with two interval fields:
`closureIntervalMs` (Int, default 600000) and `autocompleteIntervalMs` (Int, default 900000).
When no record exists the port MUST return these defaults without writing to the DB.

| Field                  | Storage type | Default   | Meaning                          |
|------------------------|--------------|-----------|----------------------------------|
| `closureIntervalMs`    | `Int`        | 600000    | IClass closure scheduler tick    |
| `autocompleteIntervalMs` | `Int`      | 900000    | Task-autocomplete scheduler tick |

#### Scenario: First read returns defaults when no record exists

- GIVEN no config record has been persisted yet
- WHEN `get()` is called on the config repository
- THEN it returns `{ closureIntervalMs: 600000, autocompleteIntervalMs: 900000 }`
- AND no DB write occurs

#### Scenario: Partial update leaves the untouched field unchanged

- GIVEN persisted config `{ closureIntervalMs: 600000, autocompleteIntervalMs: 900000 }`
- WHEN `update({ closureIntervalMs: 120000 })` is called
- THEN the stored config becomes `{ closureIntervalMs: 120000, autocompleteIntervalMs: 900000 }`
- AND a subsequent `get()` returns `autocompleteIntervalMs = 900000` (unchanged)

---

### Requirement: GET /closure/config

`GET /api/admin/iclass/closure/config` MUST respond HTTP 200 with a config DTO containing
`closureIntervalMs` (number) and `autocompleteIntervalMs` (number). It MUST NOT return raw Prisma
fields (`id`, `updatedAt`).

#### Scenario: Returns current persisted config

- GIVEN persisted config `{ closureIntervalMs: 120000, autocompleteIntervalMs: 300000 }`
- WHEN `GET /api/admin/iclass/closure/config` is called by a user with `iclass:manage`
- THEN the response is HTTP 200 with `{ closureIntervalMs: 120000, autocompleteIntervalMs: 300000 }`

#### Scenario: Returns defaults when no record exists

- GIVEN no config record has been persisted
- WHEN `GET /api/admin/iclass/closure/config` is called by a user with `iclass:manage`
- THEN the response is HTTP 200 with `{ closureIntervalMs: 600000, autocompleteIntervalMs: 900000 }`

---

### Requirement: PUT /closure/config

`PUT /api/admin/iclass/closure/config` MUST accept a validated partial body and persist it,
responding HTTP 200 with the updated config DTO. Omitted fields MUST be left untouched.

#### Scenario: Full update persists both fields

- GIVEN a user with `iclass:manage`
- WHEN `PUT` is called with `{ closureIntervalMs: 120000, autocompleteIntervalMs: 300000 }`
- THEN the response is HTTP 200 with the new values
- AND a subsequent `GET` returns the same values

#### Scenario: Partial update (only closureIntervalMs)

- GIVEN persisted config `{ closureIntervalMs: 600000, autocompleteIntervalMs: 900000 }`
- WHEN `PUT` is called with `{ closureIntervalMs: 120000 }` by a user with `iclass:manage`
- THEN the response is HTTP 200 with `{ closureIntervalMs: 120000, autocompleteIntervalMs: 900000 }`

---

### Requirement: Input validation

Both interval fields MUST be integers >= 60000 (1 minute). A body where any provided field is
non-positive, non-integer, or below 60000 MUST be rejected with HTTP 400 `{ "code": "VALIDATION_ERROR" }`
and MUST NOT persist any change.

#### Scenario: Interval below minimum rejected

- GIVEN a `PUT` body with `{ closureIntervalMs: 30000 }` (30 s < 1 min floor)
- WHEN the request is processed
- THEN the response is HTTP 400 with `{ "code": "VALIDATION_ERROR" }`
- AND the persisted config is unchanged

#### Scenario: Non-positive interval rejected

- GIVEN a `PUT` body with `{ autocompleteIntervalMs: 0 }`
- WHEN the request is processed
- THEN the response is HTTP 400 with `{ "code": "VALIDATION_ERROR" }`

#### Scenario: Wrong type rejected

- GIVEN a `PUT` body with `{ closureIntervalMs: "soon" }`
- WHEN the request is processed
- THEN the response is HTTP 400 with `{ "code": "VALIDATION_ERROR" }`

---

### Requirement: RBAC enforcement

Both `GET` and `PUT /closure/config` MUST be guarded by `auth` then `requirePerm('iclass', 'manage')`.
A request without a valid auth token MUST receive HTTP 401. A user with a valid token but without
`iclass:manage` (and not `super_admin`) MUST receive HTTP 403 `{ "code": "PERMISSION_DENIED" }`.

#### Scenario: Unauthenticated request rejected

- GIVEN no valid auth token is provided
- WHEN `GET /api/admin/iclass/closure/config` is called
- THEN the response is HTTP 401

#### Scenario: Insufficient permission rejected

- GIVEN a user with a valid token but without `iclass:manage`
- WHEN `PUT /api/admin/iclass/closure/config` is called
- THEN the response is HTTP 403 with `{ "code": "PERMISSION_DENIED" }`

#### Scenario: Authorized user succeeds

- GIVEN a user with `iclass:manage`
- WHEN `GET /api/admin/iclass/closure/config` is called
- THEN the response is HTTP 200

---

### Requirement: Bootstrap reads persisted interval at startup

Both `bootstrapIClassClosure` and `bootstrapTaskAutocomplete` MUST read `closureIntervalMs` and
`autocompleteIntervalMs` respectively from `IClassClosureConfigRepository` at startup and pass the
persisted value to the scheduler constructor via `opts.intervalMs`. The read happens ONCE at startup
(not per scheduler tick — no live reload). When no record exists, the defaults (600000 / 900000)
apply transparently via the repository contract.

#### Scenario: Closure scheduler receives persisted interval

- GIVEN persisted config `{ closureIntervalMs: 120000, autocompleteIntervalMs: 900000 }`
- WHEN `bootstrapIClassClosure()` runs
- THEN the constructed `IClassClosureScheduler` has `opts.intervalMs = 120000`

#### Scenario: Autocomplete scheduler receives persisted interval

- GIVEN persisted config `{ closureIntervalMs: 600000, autocompleteIntervalMs: 300000 }`
- WHEN `bootstrapTaskAutocomplete()` runs
- THEN the constructed `TaskAutocompleteScheduler` has `opts.intervalMs = 300000`

#### Scenario: Default interval used when no record exists

- GIVEN no config record has been persisted
- WHEN both bootstraps run
- THEN the closure scheduler receives `opts.intervalMs = 600000`
- AND the autocomplete scheduler receives `opts.intervalMs = 900000`

---

### Requirement: Interval changes require server restart (operational note)

The scheduler interval is read ONCE at bootstrap and fixed for the lifetime of the process via
`setInterval`. Updating the config via `PUT /closure/config` MUST persist the value and SHOULD be
communicated to operators that the change takes effect only after a server restart. The system MUST
NOT attempt to re-read the interval at runtime or cancel/restart the existing timer.

> NOTE: This is intentional by design — it matches the GR sync/ingest bootstrap pattern and avoids
> the complexity of live timer management. The UI SHOULD display a helper note indicating that a
> restart is required.

#### Scenario: Config update does not affect the running scheduler

- GIVEN both schedulers are running with `intervalMs = 600000`
- WHEN `PUT /closure/config` changes `closureIntervalMs` to `120000`
- THEN the running closure scheduler continues firing every 600000 ms (unchanged)
- AND only after a server restart does the scheduler use `120000`
