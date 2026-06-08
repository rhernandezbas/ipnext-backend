# Design: Network-Node Task ("Tarea de RED")

## Technical Approach

Option A: relax `ScheduledTask` with a `kind` discriminator + `networkSiteId` FK. The DB/entity/mapper/read paths are already nullable-ready for customer/contract. `CreateTask` branches validation by `kind` (inject `NetworkSiteRepository`). `SendTaskToIClass`/`dispatchTaskToIClass` substitute node-derived customer fields and pass `NetworkSite.iclassNodeCode` as the explicit `nodeCode` override (mechanism already at `IClassClient.ts:301`). Customer-mode behavior stays byte-identical. FE reuses `CreateTaskModal` via a RED toggle.

## Architecture Decisions

| # | Decision | Choice | Alternatives | Rationale |
|---|----------|--------|--------------|-----------|
| 1 | `kind` type | Plain `String @default("customer")`, app-level union `'customer'\|'network'` | Prisma enum | Project never uses Prisma enums (priority/status/type are all `String @default`); enum forces a DB type + migration churn. Backfill is trivial with a column default. |
| 2 | `networkSiteId` onDelete | `SetNull` (nullable FK) | Restrict / Cascade | Mirrors `customerId`/`contractId` (`schema.prisma:902-904`). Deleting a site must not delete its tasks; task keeps history, `kind` stays `network`. |
| 3 | Validation gating | Branch in `CreateTask.execute` by `data.kind` | Two use cases / split route | One task system, one Kanban (LOCKED). Customer branch kept identical (no regression). |
| 4 | Zod shape | `z.discriminatedUnion('kind', [...])` | `superRefine` conditional | Discriminated union gives precise per-mode required fields + clean TS narrowing; one POST stays (LOCKED). |
| 5 | IClass node mapping | Explicit `NetworkSite.iclassNodeCode` → `nodeCode` override; bypass city-node lookup for network tasks | Fuzzy name/city match | LOCKED: no fuzzy match. Deterministic, operator-controlled. |
| 6 | Phone placeholder | Constant `"0000000000"` | Empty string | `SendTaskToIClass:111` rejects blank phone (`isBlank`). A non-blank deterministic placeholder passes validation AND IClass `customer.mobile`. Apply phase MAY verify a real format against IClass; otherwise ship the constant. |
| 7 | `NetworkSiteRepository` reuse | Inject existing port (List/Get already exist) | New lookup port | CRUD + `PrismaNetworkSiteRepository` already wired (`app.ts:864-870`). Add only an `iclassNodeCode` field; use existing `getById`. |

## Data Flow

```
FE CreateTaskModal (toggle=nodo)
  → POST /scheduling/tasks { kind:'network', networkSiteId, customerId:null, contractId:null }
  → CreateTaskSchema (discriminated union)
  → CreateTask.execute: validate networkSiteId via NetworkSiteRepository; forbid customer/contract
  → repo.createTask → ScheduledTask{ kind:'network', networkSiteId }
  ... stage flow (unchanged) ...
  → SendTaskToIClass: kind==='network' → substitute fields from NetworkSite,
       nodeCode = site.iclassNodeCode (skip city-node lookup)
  → dispatchToIClass → IClassClient (nodeCode override, line 301)
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `prisma/schema.prisma` | Modify | `ScheduledTask.kind String @default("customer")`, `networkSiteId String?` + `networkSite NetworkSite? @relation(onDelete: SetNull)`, `@@index([networkSiteId])`; `NetworkSite.iclassNodeCode String?` + back-relation `scheduledTasks ScheduledTask[]` |
| `prisma/migrations/<ts>_network_node_task/migration.sql` | Create | Hand-generated via `prisma migrate diff` (additive) |
| `src/domain/entities/scheduling.ts` | Modify | Add `kind: 'customer'\|'network'`, `networkSiteId: string\|null`, `networkSiteName: string\|null` (JOIN-derived) |
| `src/domain/entities/networkSite.ts` | Modify | Add `iclassNodeCode: string \| null` |
| `src/domain/ports/SchedulingRepository.ts` | Modify | `CreateTaskInput` gains `kind`, `networkSiteId` (entity-derived) |
| `src/application/dto/scheduling.dto.ts` | Modify | `CreateTaskSchema` → discriminated union on `kind` |
| `src/application/use-cases/CreateTask.ts` | Modify | Inject `NetworkSiteRepository`; branch validation by `kind` |
| `src/application/use-cases/dispatchTaskToIClass.ts` | Modify | Network branch substitutes customer fields + nodeCode |
| `src/application/use-cases/SendTaskToIClass.ts` | Modify | Skip city-node lookup when `kind==='network'`; substitute required-field values |
| `src/infrastructure/adapters/prisma/PrismaSchedulingRepository.ts` | Modify | `INCLUDE.networkSite`, `toTask` maps `kind/networkSiteId/networkSiteName`, `_buildCreateData` writes `kind/networkSiteId` |
| `src/infrastructure/http/routes/scheduling.routes.ts` | Modify | Pass `kind/networkSiteId` through (no new route) |
| `src/infrastructure/http/app.ts` | Modify | Wire `NetworkSiteRepository` into `CreateTask` |
| FE `CreateTaskModal.tsx` | Modify | RED toggle, NodeSelector, `canSave` branch, network payload |
| FE NetworkSite form + `types/networkSite.ts` | Modify | `iclassNodeCode` field |
| FE kanban card + task list | Modify | RED badge when `kind==='network'` |

## Interfaces / Contracts

```ts
// scheduling.dto.ts — discriminated union (one POST)
const CustomerTask = CreateTaskBaseSchema.extend({
  kind: z.literal('customer'),
  customerId: z.string().min(1),
  contractId: z.string().min(1),
});
const NetworkTask = CreateTaskBaseSchema.extend({
  kind: z.literal('network'),
  networkSiteId: z.string().min(1),
  customerId: z.null().optional(),
  contractId: z.null().optional(),
});
export const CreateTaskSchema = z
  .discriminatedUnion('kind', [CustomerTask, NetworkTask])
  .superRefine(dateRangeRefine);
```

```ts
// CreateTask.execute — gate (customer branch byte-identical to today)
if (data.kind === 'network') {
  const site = await this.networkSites.getById(data.networkSiteId!);
  if (!site) throw new ReferenceNotFoundError('networkSite', data.networkSiteId!);
  // customer/contract already absent via schema; do NOT run customer/contract lookups
} else {
  /* existing customerId + contractId assertions, unchanged */
}
```

```ts
// dispatchTaskToIClass — network substitution (NETWORK_PHONE = '0000000000')
const isNet = task.kind === 'network';
customerCode: isNet ? (site.iclassNodeCode ?? 'NETWORK') : task.customerCode!,
customerName: isNet ? task.networkSiteName! : task.customerName!,
phone:        isNet ? NETWORK_PHONE : task.customerPhone!,
address:      isNet ? (site.address ?? task.networkSiteName!) : task.address!,
city:         isNet ? (site.city ?? '') : task.customerCity!,
soType:       soTypeCode,           // still from chosen Project (unchanged)
nodeCode:     isNet ? site.iclassNodeCode! : resolvedNodeCode,
```
For network tasks `SendTaskToIClass` skips the `listNodes()` city match (step 5) and uses `site.iclassNodeCode` directly; required-field validation runs against the substituted values, not the (null) customer fields. soType still resolves from the Project mapping (unchanged).

## Testing Strategy

| Layer | What | Approach |
|-------|------|----------|
| Unit | `CreateTask` both kinds: network validates site exists + forbids customer/contract; customer branch unchanged | `InMemorySchedulingRepository` + `InMemoryNetworkSiteRepository` |
| Unit | Zod union: rejects network w/ customerId, rejects customer w/o contract | schema `.safeParse` |
| Unit | `SendTaskToIClass` network: substitutes fields, sends `iclassNodeCode`, skips city lookup; customer path regression | in-memory IClass port |
| Integration | `POST /scheduling/tasks` network payload → 201 with `kind:'network'` | supertest + in-memory repos |

## Migration / Rollout

Additive. Generate SQL with `prisma migrate diff --from-schema-datamodel <HEAD copy> --to-schema-datamodel prisma/schema.prisma --script` (NOT `migrate dev`). Columns: `kind` (NOT NULL DEFAULT 'customer' — backfills all existing rows to `customer`), `networkSiteId` (nullable FK `ON DELETE SET NULL`), `iclassNodeCode` (nullable). Rollback = revert FE toggle + BE branch; drop columns only on full revert.

## Open Questions

- [ ] Confirm IClass accepts `mobile:"0000000000"`; if it demands a real format, apply phase substitutes a valid placeholder.
- [ ] `customerCode` for network SO: `iclassNodeCode` vs fixed `"NETWORK"` — confirm IClass char limit / uniqueness expectations during apply.
