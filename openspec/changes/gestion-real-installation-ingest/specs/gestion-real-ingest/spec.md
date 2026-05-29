# Spec — gestion-real-ingest

**Capability**: `gestion-real-ingest`
**Type**: New (full capability — no prior spec exists)
**Change**: `gestion-real-installation-ingest`
**Layer**: Domain port + Application use-case + Infrastructure scheduler

---

## Purpose

Periodically ingest pending installation service orders (`tipo == "CI"`) from Gestión Real (GR),
resolve their local client/service links, classify the technology as FIBER or WIRELESS from the
plan download speed, and create one idempotent `ScheduledTask` per order. The use-case depends
only on ports (`GestionRealPort`, repositories, config) — never on concrete infrastructure — and
returns DTOs, never raw Prisma entities.

---

## 1. Upstream Source — GR `ordenesdeservicio`

### REQ-SRC-1: Port gains `getServiceOrders`

`GestionRealPort` MUST expose a `getServiceOrders` method that fetches pending CI-eligible orders
from the GR `ordenesdeservicio` action. The adapter MUST send `estado=PEND`, `fecha_tipo=c`, and a
date window `fechaDesde`..`fechaHasta` derived from config (depth in months back to today). The
adapter MUST normalize the GR dict-keyed response (keyed by order id) into a flat array of orders;
the application layer MUST NOT see the raw GR payload shape.

#### Scenario: Adapter normalizes dict response to array

- GIVEN GR returns `{ "551": {...}, "552": {...} }`
- WHEN `getServiceOrders` resolves
- THEN it returns an array of 2 normalized order objects, each carrying its order id
- AND each order exposes at minimum `grOrdenId`, `tipo`, `cliente`, `contrato`, `domicilio`

### REQ-SRC-2: Each normalized order carries the fields the ingest needs

The normalized order MUST include: `grOrdenId` (the dict key), `tipo`, `cliente` (GR client id),
`contrato` (GR contract id), and `domicilio` (address/locality text). Missing optional fields MUST
be `null`, never `undefined`.

#### Scenario: Order missing domicilio maps to null

- GIVEN a GR order with no `domicilio`
- WHEN normalized
- THEN `order.domicilio` is `null`

---

## 2. CI Filtering

### REQ-FILTER-1: Only `tipo == "CI"` orders are processed

The ingest use-case MUST filter orders CLIENT-SIDE so that only `tipo == "CI"` (installations) are
processed. Orders with `tipo` of `CO`, `BA`, `IN`, or any other value MUST be ignored and MUST NOT
produce a `ScheduledTask`.

#### Scenario: Non-CI orders are skipped

- GIVEN a batch with one `CI` and two `CO` orders
- WHEN the ingest runs
- THEN exactly one `ScheduledTask` is considered for creation (the CI order)
- AND the `CO` orders produce no task

---

## 3. Local FK Resolution

### REQ-FK-1: Resolve client and service from the local mirror

For each CI order the use-case MUST resolve `order.cliente` to a local `Client` by `grClienteId`
and `order.contrato` to a local `Service` by `grContratoId`, using the local mirror repositories
(ports), NOT a live GR call.

#### Scenario: Both resolved → task creation proceeds

- GIVEN a CI order whose `cliente` and `contrato` both exist in the local mirror
- WHEN the ingest runs
- THEN the resolved `Client.id` and `Service.id` are used as `customerId`/`serviceId` on the task

### REQ-FK-2: Unmirrored client or service → skip + log, do not error batch

If the `Client` (by `grClienteId`) OR the `Service` (by `grContratoId`) is NOT found locally, the
use-case MUST SKIP that order for this run, MUST log it as `skipped-unmirrored`, and MUST continue
processing the remaining orders. It MUST NOT throw or abort the batch. The order is expected to
resolve on a later run once the mirror catches up.

#### Scenario: Missing service skips one order, batch continues

- GIVEN a batch with two CI orders, one whose `contrato` has no local `Service`
- WHEN the ingest runs
- THEN the unmirrored order is skipped and counted as `skipped-unmirrored`
- AND the other order still produces a `ScheduledTask`
- AND no exception propagates

---

## 4. Technology Classification

### REQ-TECH-1: Parse download speed from the plan name

The classifier MUST parse the DOWNLOAD speed as the FIRST integer found in `Service.plan`
(e.g. `"50/25MB"` → 50, `"300MB"` → 300, `"20/5MB GRAL"` → 20). If no integer is present the speed
is unparseable.

#### Scenario: First integer is taken as download speed

- GIVEN `Service.plan = "20/5MB GRAL"`
- WHEN classified
- THEN parsed speed is 20

### REQ-TECH-2: Classification thresholds

The classifier MUST classify: speed ≥ 100 Mbps → `FIBER`; speed < 100 Mbps → `WIRELESS`;
unparseable (no number, or `plan` is null/empty) → `UNCLASSIFIED`.

#### Scenario: Speed exactly 100 is FIBER

- GIVEN parsed speed = 100
- WHEN classified
- THEN result is `FIBER`

#### Scenario: Speed 20 is WIRELESS

- GIVEN `Service.plan = "20/5MB GRAL"`
- WHEN classified
- THEN result is `WIRELESS`

#### Scenario: Missing plan is UNCLASSIFIED

- GIVEN `Service.plan = null`
- WHEN classified
- THEN result is `UNCLASSIFIED`

---

## 5. Task Creation

### REQ-CREATE-1: FIBER order creates a task targeting the fiber project

For a CI order classified `FIBER`, the use-case MUST create a `ScheduledTask` with `customerId`
and `serviceId` from the resolved FKs, address/locality from `order.domicilio`, and the target
`projectId` set to the configured `fiberProjectId`.

#### Scenario: Happy-path fiber

- GIVEN a CI order resolving to a client+service with plan `"300MB"` and config `fiberProjectId = "p-fiber"`
- WHEN the ingest runs
- THEN a `ScheduledTask` is created with `customerId`/`serviceId` set and `projectId = "p-fiber"`
- AND `grOrdenId` equals the GR order id

### REQ-CREATE-2: WIRELESS order creates a task targeting the wireless project

For a CI order classified `WIRELESS`, the use-case MUST create a `ScheduledTask` with the target
`projectId` set to the configured `wirelessProjectId`.

#### Scenario: Happy-path wireless

- GIVEN a CI order with plan `"50/25MB"` and config `wirelessProjectId = "p-wifi"`
- WHEN the ingest runs
- THEN a `ScheduledTask` is created with `projectId = "p-wifi"`

### REQ-CREATE-3: UNCLASSIFIED order creates a needs-review task with no project

For a CI order classified `UNCLASSIFIED`, the use-case MUST STILL create a `ScheduledTask` but with
`projectId = null`, a title prefixed `[REVISAR - Logística] Instalación <clientName>`, and a
description stating the reason (e.g. `"Plan no reconocido — asignar tecnología y proyecto manualmente"`).
The order MUST NEVER be dropped.

#### Scenario: Unparseable plan becomes needs-review

- GIVEN a CI order resolving to a service whose plan has no number
- WHEN the ingest runs
- THEN a `ScheduledTask` is created with `projectId = null`
- AND the title starts with `[REVISAR - Logística] Instalación`
- AND the description contains the manual-assignment reason
- AND it is counted as `unclassified`

---

## 6. Idempotency

### REQ-IDEMP-1: `grOrdenId` keys task creation; re-runs do not duplicate

`ScheduledTask.grOrdenId` (unique, nullable) MUST hold the GR order id. Before creating a task the
use-case MUST check whether a task with that `grOrdenId` already exists; if so it MUST skip
(no-op upsert), count it as `skipped-duplicate`, and MUST NOT create a second task.

#### Scenario: Idempotent re-run creates no duplicates

- GIVEN a CI order already ingested as a `ScheduledTask` with its `grOrdenId`
- WHEN the ingest runs again over the same order
- THEN no new `ScheduledTask` is created
- AND the order is counted as `skipped-duplicate`
- AND the total task count is unchanged

---

## 7. Scheduler

### REQ-SCHED-1: Periodic scheduler driven by config, advisory-locked

A scheduler MUST drive the ingest on the configured interval (default ~3 min, config-driven),
mirroring `GestionRealSyncScheduler` (interval timer + Postgres advisory lock for multi-replica
safety). It MUST acquire the advisory lock before running and release it afterwards so that two
replicas never run the ingest concurrently.

#### Scenario: Lock held by another replica skips this run

- GIVEN the advisory lock is already held by another replica
- WHEN the scheduler tick fires
- THEN this replica MUST NOT run the ingest for that tick

### REQ-SCHED-2: Ingest runs only when enabled in config

The scheduler MUST run the ingest only when config `enabled = true`. When `enabled = false` the
scheduler MUST NOT call the ingest use-case and MUST create no tasks.

#### Scenario: Config disabled → no ingest

- GIVEN config `enabled = false`
- WHEN the scheduler tick fires
- THEN the ingest use-case is NOT invoked
- AND no `ScheduledTask` is created
