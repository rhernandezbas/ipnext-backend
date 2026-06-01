# Change: service-stats

## Intent

Add `GET /api/services/stats` so the Contratos page can display a stats bar (Total + breakdown by status), mirroring the existing `/api/clients/stats` feature.

## Scope

- **New port method**: `ServiceRepository.stats(): Promise<ServiceStats>` — dynamic `groupBy status`, no hardcoded statuses.
- **New use case**: `GetServiceStats` (hexagonal, depends on port only).
- **New route**: `GET /api/services/stats` (auth-guarded, mounted before listing route).
- **New DTO**: `ServiceStats { total: number; byStatus: Record<string, number> }`.
- **Adapters updated**: `InMemoryServiceRepository.stats()` + `PrismaServiceRepository.stats()`.
- **No schema migration required** — reads from existing `Service.status` column.

## Approach

Clone the `GetClientStats` / `ClientStats` pattern exactly:
- Dynamic `groupBy status` — returns whatever statuses exist in the DB (e.g. "Vigente", "Baja").
- No mapping, no hardcoding — `byStatus` is a plain `Record<string, number>`.
- Route mounted at `/api/services/stats` BEFORE the listing route as defensive convention.

## Rollback

Delete `GetServiceStats.ts`, revert `ServiceRepository.ts`, `InMemoryServiceRepository.ts`, `PrismaServiceRepository.ts`, and `services.routes.ts` to their pre-change state. No DB migration to roll back.
