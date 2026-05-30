# Design: Gestión Real Installation Order Ingest

## Technical Approach

Mirror the existing GR sync stack end-to-end. The domain port `GestionRealPort` gains
`getServiceOrders`; the `GestionRealClient` adapter implements the `ordenesdeservicio` action
(daily-MD5 Basic auth, POST root, dict-keyed response → flat `GrServiceOrder[]`). A new use-case
`IngestGestionRealOrders` orchestrates fetch → filter CI → resolve FKs locally → classify →
resolve target project → idempotency check → create `ScheduledTask`. A pure `classifyTech` function
does the FIBER/WIRELESS/UNCLASSIFIED decision. A typed config (`GestionRealIngestConfig`, single
row) backs the editable mapping via a new port + Prisma/InMemory repos. A scheduler
(`GestionRealIngestScheduler`) drives it, mirroring `GestionRealSyncScheduler` exactly (interval +
intra-process flag + `DistributedLock`). Routes in `gestionRealIngest.routes.ts` expose
config/status/needs-review, wired thinly in `app.ts`.

## Architecture Decisions

| Decision | Options | Choice + Rationale |
|---|---|---|
| Config storage | Reuse `SyncState` KV / new typed table | **New `GestionRealIngestConfig` table.** Spec REQ-CFG-1 demands typed fields + real FK→Project; KV can't enforce FKs or types. |
| FK-by-GR resolution | Extend `ClientMirrorRepository` / new read port | **New `GrLinkResolverPort`** (`findClientByGrId`, `findServiceByGrContratoId`). MirrorRepository is write-side by design (its own doc says so); reads belong elsewhere. |
| Task creation path | Reuse `SchedulingRepository` / new ingest port | **Reuse `SchedulingRepository`** (`createTask`, plus a new `findTaskByGrOrdenId` + `listNeedsReview`). Same entity, same in-memory testability; no parallel write path. |
| Idempotency | DB upsert / check-then-create | **Check-then-create** by `grOrdenId` (REQ-IDEMP-1 says "check first, skip"). Unique column is the DB backstop, not the primary mechanism. Avoids upsert semantics on a 20-field create. |
| Status counts | Field on config / reuse SyncState | **Reuse `SyncStateRepository`** with entity key `gr-ingest`. `lastRunAt` + a JSON-encoded counts blob in `lastResult` (or itemsSynced=created). Keeps config immutable-by-user; status is sync metadata, exactly what SyncState is for. |
| Initial stage | Hardcode / resolve from project workflow | **Resolve via `SchedulingRepository.getStageByName('Pendiente', project.workflowId)`** with the existing default-pending stage as fallback. Tasks must land in a valid pending stage; needs-review (null project) uses the global default. |
| Advisory lock key | Reuse `gr-sync` / new key | **`gr-ingest`.** `PgAdvisoryLock` hashes the key string, so a distinct string is a distinct lock — must differ from clients sync or they'd block each other. |

## Data Flow

    Scheduler tick ─▶ IngestGestionRealOrders (flag OFF → no-op)
        │  getServiceOrders(estado=PEND, fecha_tipo=c, window)
        ▼
    GestionRealClient ──▶ GrServiceOrder[]  ──filter tipo=="CI"──▶
        per order:
          GrLinkResolverPort.findClientByGrId(cliente)      ─┐ miss → skip+count(unmirrored)
          GrLinkResolverPort.findServiceByGrContratoId(contrato) ┘
          classifyTech(service.plan) → FIBER|WIRELESS|UNCLASSIFIED
          config → fiberProjectId|wirelessProjectId|null
          SchedulingRepository.findTaskByGrOrdenId(id) → exists → skip+count(duplicate)
          else SchedulingRepository.createTask({...})  → count(created|unclassified)
        ▼
    SyncStateRepository.save({entity:'gr-ingest', lastRunAt, counts})

## File Changes

| File | Action | Description |
|---|---|---|
| `src/domain/entities/gestionReal.ts` | Modify | Add `GrServiceOrder` interface |
| `src/domain/ports/GestionRealPort.ts` | Modify | Add `getServiceOrders(params)` + `GetServiceOrdersParams` |
| `src/domain/ports/GrLinkResolverPort.ts` | Create | Read-side FK resolution by GR id |
| `src/domain/ports/GestionRealIngestConfigRepository.ts` | Create | Config port (`get`, `update`) + `IngestConfig` type |
| `src/domain/ports/SchedulingRepository.ts` | Modify | Add `findTaskByGrOrdenId`, `listNeedsReview`; `CreateTaskInput` already allows `grOrdenId` via entity add |
| `src/domain/entities/scheduling.ts` | Modify | Add `grOrdenId: string \| null` |
| `src/application/use-cases/IngestGestionRealOrders.ts` | Create | The orchestrator use-case + `IngestRunResult` DTO |
| `src/application/use-cases/classifyTech.ts` | Create | Pure classifier function |
| `src/application/use-cases/GetIngestConfig.ts` / `UpdateIngestConfig.ts` / `GetIngestStatus.ts` / `ListNeedsReviewTasks.ts` | Create | Config/status/review use-cases (VerbNoun, one per file) |
| `src/application/dto/gestionRealIngest.dto.ts` | Create | Config/status/needs-review DTOs + mappers |
| `src/infrastructure/adapters/gestion-real/GestionRealClient.ts` | Modify | Implement `getServiceOrders` + `parseServiceOrdersResponse` (exported, pure) |
| `src/infrastructure/adapters/prisma/PrismaGrLinkResolver.ts` | Create | Prisma read of Client/Service by GR id |
| `src/infrastructure/adapters/in-memory/InMemoryGrLinkResolver.ts` | Create | In-memory resolver for tests |
| `src/infrastructure/adapters/prisma/PrismaGestionRealIngestConfigRepository.ts` | Create | Single-row config, defaults on first read |
| `src/infrastructure/adapters/in-memory/InMemoryGestionRealIngestConfigRepository.ts` | Create | In-memory config |
| `src/infrastructure/scheduling/GestionRealIngestScheduler.ts` | Create | Interval + inFlight + advisory lock (`gr-ingest`) |
| `src/infrastructure/scheduling/bootstrapGestionRealIngest.ts` | Create | Composition root → scheduler\|null |
| `src/infrastructure/http/routes/gestionRealIngest.routes.ts` | Create | GET/PUT config, GET status, GET needs-review |
| `src/infrastructure/http/app.ts` | Modify | One `app.use('/api/gestion-real-ingest', ...)` wire |
| `src/main.ts` | Modify | `bootstrapGestionRealIngest()` + start (mirrors grSync) |
| `prisma/schema.prisma` + migration | Modify | `ScheduledTask.grOrdenId String? @unique`; new `GestionRealIngestConfig` model |

## Interfaces / Contracts

```ts
// domain/entities/gestionReal.ts
export interface GrServiceOrder {
  grOrdenId: string;            // the dict key
  tipo: string | null;         // "CI" | "CO" | "BA" | "IN" | ...
  estado: string | null;       // "PEND"
  cliente: string | null;      // GR client id
  contrato: string | null;     // GR contract id
  domicilio: { direccion: string | null; localidad: string | null; provincia: string | null } | null;
  fechaCreacion: string | null;
  raw: Record<string, unknown>;
}

// domain/ports/GestionRealPort.ts (added)
export interface GetServiceOrdersParams {
  estado?: string;             // default 'PEND'
  fechaTipo?: 'c' | 'm' | 'co';// default 'c'
  fechaDesde?: string;         // "DD-MM-AAAA", now − windowMonths
  fechaHasta?: string;         // "DD-MM-AAAA", today
}
getServiceOrders(params: GetServiceOrdersParams): Promise<GrServiceOrder[]>;

// domain/ports/GrLinkResolverPort.ts
export interface GrLinkResolverPort {
  findClientByGrId(grClienteId: string): Promise<{ id: string; name: string } | null>;
  findServiceByGrContratoId(grContratoId: string): Promise<{ id: string; plan: string | null } | null>;
}

// domain/ports/GestionRealIngestConfigRepository.ts
// Runtime on/off is the `gestion-real-ingest` feature flag, NOT a config field.
export interface IngestConfig {
  intervalMs: number; windowMonths: number;
  fiberProjectId: string | null; wirelessProjectId: string | null;
}
export interface GestionRealIngestConfigRepository {
  get(): Promise<IngestConfig>;          // returns defaults if no row
  update(patch: Partial<IngestConfig>): Promise<IngestConfig>;
}

// application/use-cases/classifyTech.ts  (pure)
export type TechClass = 'FIBER' | 'WIRELESS' | 'UNCLASSIFIED';
export function classifyTech(plan: string | null): TechClass;
// rule: const m = (plan ?? '').match(/\d+/); if (!m) UNCLASSIFIED;
//       const speed = parseInt(m[0],10); speed >= 100 ? FIBER : WIRELESS

export interface IngestRunResult {
  created: number; skippedDuplicate: number; skippedUnmirrored: number; unclassified: number;
}
```

## Mechanics

1. `getServiceOrders({ estado:'PEND', fechaTipo:'c', fechaDesde: now−windowMonths, fechaHasta: today })`.
2. Filter client-side `tipo === 'CI'`.
3. Per order: resolve client by `cliente`, service by `contrato` via `GrLinkResolverPort`. Either miss → `skippedUnmirrored++`, log, continue (no throw).
4. `classifyTech(service.plan)`.
5. Resolve target project: FIBER→`fiberProjectId`, WIRELESS→`wirelessProjectId`, UNCLASSIFIED→`null`.
6. `findTaskByGrOrdenId(grOrdenId)` → exists → `skippedDuplicate++`, continue.
7. Build `CreateTaskInput`: `customerId`, `serviceId`, `grOrdenId`, `address`/`coordinates` from `domicilio`, `projectId`, `category:'installation'`, stage resolved via project workflow (fallback default-pending). UNCLASSIFIED → `projectId:null`, `title:'[REVISAR - Logística] Instalación <clientName>'`, `description:'Plan no reconocido — asignar tecnología y proyecto manualmente'`, `unclassified++`; else `created++`.
8. After loop: `SyncStateRepository.save({ entity:'gr-ingest', lastRunAt:now, lastResult: JSON.stringify(counts), itemsSynced: created })`.

Status endpoint reads `gr-ingest` SyncState; `lastRunAt=null` + zero counts when absent. Advisory
lock key = `gr-ingest` (distinct from `gr-sync`). Scheduler: `inFlight` guard, `tryAcquire`,
always delegates to the use-case (the `gestion-real-ingest` feature flag is the sole runtime gate,
checked inside the use-case → flag OFF is a no-op), swallows errors so one bad cycle never kills the timer.

## Data Model (Prisma delta — one additive migration)

```prisma
model ScheduledTask {
  // ...existing fields...
  grOrdenId String? @unique     // GR order id; null for manual tasks. NULL-distinct unique.
  // (optional @@index([grOrdenId]) — @unique already creates a btree index)
}

model GestionRealIngestConfig {
  id                String   @id @default("singleton")   // enforce single row
  intervalMs        Int      @default(180000)
  windowMonths      Int      @default(12)
  fiberProjectId    String?
  fiberProject      Project? @relation("GrIngestFiber", fields: [fiberProjectId], references: [id], onDelete: SetNull)
  wirelessProjectId String?
  wirelessProject   Project? @relation("GrIngestWireless", fields: [wirelessProjectId], references: [id], onDelete: SetNull)
  updatedAt         DateTime @updatedAt
}
// Project gets two back-relations: grIngestFiber / grIngestWireless GestionRealIngestConfig[]
```

Migration intent: add nullable unique `grOrdenId` to `ScheduledTask`; create
`GestionRealIngestConfig` with the two nullable Project FKs (`onDelete: SetNull`). Additive +
nullable → safe rollback (leave columns in place). Generate via `npm run prisma:migrate`.

## DI Wiring

- `bootstrapGestionRealIngest.ts`: builds `GestionRealClient`, `PrismaGrLinkResolver`,
  `PrismaGestionRealIngestConfigRepository`, `PrismaSchedulingRepository`,
  `PrismaSyncStateRepository`, `PgAdvisoryLock`, `IngestGestionRealOrders`,
  `GestionRealIngestScheduler`. Returns `null` when `GR_SYNC_ENABLED` is off or GR creds are missing.
  The runtime on/off is the `gestion-real-ingest` feature flag, checked per-run inside the use-case,
  so it can be toggled without redeploy.
- `main.ts`: `const grIngest = bootstrapGestionRealIngest(); grIngest?.start();` (mirrors `grSync`).
- `app.ts`: single `app.use('/api/gestion-real-ingest', createGestionRealIngestRouter(authProvider, getIngestConfig, updateIngestConfig, getIngestStatus, listNeedsReviewTasks))`. `UpdateIngestConfig` takes the `ProjectRepository`/`EntityLookup` to validate FK existence (404 PROJECT_NOT_FOUND; null clears without lookup — REQ-PUTCFG-2).

## Defaults (settled)

`intervalMs=180000` (~3 min), `windowMonths=12`, `estado='PEND'`, `fechaTipo='c'`. Runtime on/off
is the `gestion-real-ingest` feature flag (ships OFF). REVISAR title `[REVISAR - Logística] Instalación <clientName>`; description
`Plan no reconocido — asignar tecnología y proyecto manualmente`.

## Testing Strategy

| Layer | What | How |
|---|---|---|
| Unit | `classifyTech` boundaries (`"300MB"`→FIBER, `"50/25MB"`→WIRELESS, `"20/5MB GRAL"`→20/WIRELESS, `100`→FIBER, `null`/`"FIBRA"`→UNCLASSIFIED) | Pure fn, table-driven |
| Unit | `parseServiceOrdersResponse` dict→array, null domicilio | Pure parser, fixture payload |
| Unit | `IngestGestionRealOrders` (CI filter, unmirrored skip, idempotent re-run, FIBER/WIRELESS/UNCLASSIFIED paths, counts) | In-memory `GestionRealPort` fake + `InMemoryGrLinkResolver` + `InMemorySchedulingRepository` + `InMemoryGestionRealIngestConfigRepository` + `InMemorySyncStateRepository`. NO Prisma mocks. |
| Unit | Scheduler delegates to use-case (flag-OFF no-op) + lock-held skip | `InMemoryDistributedLock` + `InMemoryFeatureFlagRepository` |
| Integration | routes GET/PUT config (400 bad body, 404 ghost project, null clear), GET status, GET needs-review | supertest + in-memory adapters |

## Migration / Rollout

One additive migration. Feature ships with the `gestion-real-ingest` feature flag OFF → no ingest
until an operator sets projects and flips the flag via `/feature-flags`. Rollback = flip the flag OFF
(instant) or revert branch; columns are nullable/additive, harmless to leave.

## Open Questions

- None blocking. `fechaTipo` may later need `co` if `c` misses re-opened orders — config-overridable.
