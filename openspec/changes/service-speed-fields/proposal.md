<!-- generated from engram topic_key: sdd/service-speed-fields/proposal -->
## Intent
Expose per-`Service` `downloadSpeed` and `uploadSpeed` (Mbps) so the frontend task-service picker can render `10/5 — <address>` labels (see ipnext-frontend `sdd/task-service-picker-richer-label/proposal`).

## Why
- `Service.plan` is a free-text string ("Plan 100Mbps", "Empresarial 200MB", …). Parsing client-side is fragile.
- `ServicePlan` model has structured `downloadSpeed`/`uploadSpeed` but `Service` has no FK to it.
- GR mirror is the source of truth for contracts; speed data, if present, lives in the raw contract payload (field name TBD — Phase 0 discovery needed, candidate keys: `velocidad`, `bajada`, `subida`, `velocidad_bajada`).

## Proposed change — option A (recommended)
Additive, low-risk, mirrors prior `task-service-location` pattern:
1. Prisma migration: add `downloadSpeed Int?` and `uploadSpeed Int?` to `model Service` (both nullable).
2. Domain entity `src/domain/entities/customer.ts` `Service`: add `downloadSpeed: number | null`, `uploadSpeed: number | null`.
3. Backfill plan:
   - GR adapter `GestionRealClient.parseContractsResponse`: extract speeds from raw payload (Phase 0 discovery to confirm field names). Default null when absent.
   - Splynx adapter `SplynxCustomerAdapter.listServices`: pass-through if Splynx exposes them (`SplynxService` likely lacks them — keep null).
   - Optional: one-shot backfill script joining `Service.plan` against `ServicePlan.name` when an exact match exists.
4. Prisma adapter / mirror upsert: persist new columns.
5. Route `GET /clients/:id/services`: surface `downloadSpeed`/`uploadSpeed` in DTO. Update OpenAPI / contract docs (currently the example in `task-service-location/design.md` lists the existing shape).
6. Tests: extend `clients.routes.test.ts` to assert new keys present (nullable allowed).

## Phase 0 (must do first)
Discover the actual GR raw field name(s) for download/upload speed on a contract. The previous `task-service-location` change documented similar discovery against a live GR sample. Without this, the migration would land empty columns and the frontend still couldn't render speeds.

## Rollback
Drop columns. Frontend falls back to `plan (type)` per REQ-PICKER-1.

## Cross-reference
- Frontend blocker: `sdd/task-service-picker-richer-label/{explore,proposal,spec}` (project: ipnext-frontend).
- Pattern reference: openspec/changes/task-service-location/{proposal,design}.md (additive Service columns, GR parser extension).
