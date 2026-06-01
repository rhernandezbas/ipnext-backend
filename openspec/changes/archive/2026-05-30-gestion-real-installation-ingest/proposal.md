# Proposal: Gestión Real Installation Order Ingest

## Intent

Today installation service orders live only in Gestión Real (GR). Operators manually re-create them as scheduling tasks, which is slow, error-prone, and loses the client/service link. We want the backend to automatically ingest GR installation orders (`tipo == "CI"`) and turn each into a `ScheduledTask` with client and service already linked, classified as FIBER or WIRELESS, ready for the existing IClass send flow. There are 30 pending CI orders right now (884 pending total). This is the BACKEND-FIRST half; a future "Gestión Real" subpage (separate FE repo) will consume the endpoints built here.

## Scope

### In Scope
- New GR action `ordenesdeservicio` on `GestionRealPort` + `GestionRealClient` adapter (estado/fecha_tipo/date window; dict-keyed response).
- New ingest use-case: fetch pending orders, filter `tipo == "CI"` client-side, resolve `order.cliente → Client.grClienteId` and `order.contrato → Service.grContratoId` from the LOCAL mirror, classify tech from `Service.plan` download speed (≥100 Mbps → FIBER, else WIRELESS), create `ScheduledTask`.
- Tech classifier (parse first number of plan name; unparseable → unclassified).
- Unclassified orders: still create the task WITHOUT a target project, flagged in title/description for LOGÍSTICA review.
- Additive Prisma migration: `ScheduledTask.grOrdenId` (unique, nullable) for idempotency.
- Config store (target project per tech, ingest enabled, sync interval) — editable, NOT hardcoded.
- Periodic scheduler mirroring `GestionRealSyncScheduler` (interval + advisory lock).
- HTTP endpoints: read/update config; sync status (last run, counts); list needs-review tasks.

### Out of Scope
- The FE subpage UI (separate repo, follow-up).
- IClass send flow (`SendTaskToIClass` already exists, downstream).
- Any write-back to GR.
- Ingesting non-CI types (CO/BA/IN).
- Segment/residential/corporate/area filtering (explicitly: ingest ALL CI).

## Capabilities

### New Capabilities
- `gestion-real-ingest`: fetch GR installation orders, map to ScheduledTask with client/service link and FIBER/WIRELESS classification, idempotent via grOrdenId, with periodic scheduler.
- `gestion-real-ingest-config`: stored, editable mapping (tech→ProjectId), ingest on/off, sync interval, plus sync-status and needs-review query endpoints.

### Modified Capabilities
- `scheduling`: `ScheduledTask` gains `grOrdenId` (unique, nullable) and may be created by the ingest engine with no project (needs-review state).

## Approach

Mirror the existing GR sync pattern. Domain port gains `getServiceOrders`; adapter implements the daily-MD5 Basic-auth call. A `IngestGestionRealOrders` use-case (in-memory tested) orchestrates: pull → filter CI → resolve FKs locally → classify → upsert ScheduledTask keyed on `grOrdenId`. A config port + repository (Prisma + in-memory) backs the editable mapping. A scheduler drives it on the configured interval. Routes file (`gestionRealIngest.routes.ts`) exposes config/status/needs-review; wired in `app.ts` minimally.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/domain/ports/GestionRealPort.ts` | Modified | Add `getServiceOrders` |
| `src/infrastructure/adapters/gestion-real/GestionRealClient.ts` | Modified | Implement `ordenesdeservicio` |
| `src/application/use-cases/` | New | `IngestGestionRealOrders.ts` + tech classifier |
| `src/domain/ports/` + adapters | New | Ingest config port + Prisma/InMemory repos |
| `prisma/schema.prisma` + migration | Modified | `ScheduledTask.grOrdenId`; config store table |
| `src/infrastructure/scheduling/` | New | Ingest scheduler (interval + advisory lock) |
| `src/infrastructure/http/routes/` + `app.ts` | New/Modified | Ingest config/status/needs-review routes |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Duplicate tasks on re-sync | Med | Unique `grOrdenId`, upsert-by-key |
| Plan name unparseable | Med (3/30) | Create needs-review task, no project, LOGÍSTICA note |
| FK miss (client/service not yet mirrored) | Low | Rely on 3-min sync; skip+retry next run, log it |
| `app.ts` bloat | Low | Single thin router wire only |

## Rollback Plan

Disable via config flag (`ingest enabled = false`) — scheduler stops creating tasks immediately, no deploy needed. Code rollback: revert the change branch. The `grOrdenId` column and config table are additive/nullable — leaving them in place is harmless; no destructive migration to undo.

## Dependencies

- GR env vars `GR_CUIT`, `GR_SECRET`, `GR_BASE_URL` (already in `config.ts`).
- Local `Client.grClienteId` / `Service.grContratoId` mirror kept fresh by `GestionRealSyncScheduler`.

## Success Criteria

- [ ] Periodic ingest creates one `ScheduledTask` per pending CI order, no duplicates across runs.
- [ ] Tasks carry linked customerId/serviceId and correct FIBER/WIRELESS target project per config.
- [ ] Unparseable-plan orders become needs-review tasks (no project, LOGÍSTICA note), never dropped.
- [ ] Endpoints return/update config, expose sync status, and list needs-review tasks.

## Open Questions

- Default date window depth for `fecha_desde` (e.g. last 30/90 days vs all-pending)?
- Default sync interval (match GR ~3 min, or slower for installs)?
- Config store: dedicated typed table vs generic key-value store?
- Exact LOGÍSTICA note text/format for needs-review tasks?
- Should `fecha_tipo` be c (created), m (modified), or co — which best captures "new pending installs"?
