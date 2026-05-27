# Exploration: clients-section

**Change**: clients-section
**Date**: 2026-05-09
**Status**: complete — pending user answers before proposal

---

## Current State

### Entity `Customer` (`src/domain/entities/customer.ts`)
Fields: `id`, `name`, `email`, `phone`, `status` (active|late|blocked|inactive), `address`, `city`, `country`, `login`, `createdAt`, `customAttributes?`

Missing: `firstName`/`lastName` split, document number, `clientType`, segment, `partnerId`, `ubicacionId`, `splynxId`.

### Port `CustomerRepository` (`src/domain/ports/CustomerRepository.ts`)
Only READ methods: `list(query)`, `findById(id)`, `listServices(clientId)`, `listInvoices(clientId)`, `listLogs(query)`.
NO write methods: no `create`, `update`, `delete`, `changeStatus`.

### Splynx Adapter (`src/infrastructure/adapters/splynx/SplynxCustomerAdapter.ts`)
Maps Splynx fields: `id`, `name`, `email`, `phone`, `status`, `street_1→address`, `city`, `country`, `login`, `date_add→createdAt`.
Status codes: 1→active, 2→blocked, 3→inactive, 4→late.

### Routes (`src/infrastructure/http/routes/clients.routes.ts`)

| Endpoint | Current impl |
|----------|-------------|
| GET /clients | ListClients use case → Splynx |
| GET /clients/online | hardcoded in-memory array (8 sessions) |
| DELETE /clients/online/:sessionId | splice from in-memory array |
| GET /clients/:id | GetClientDetail → Splynx |
| DELETE /clients/:id | only works for newClientsStore (in-memory) |
| POST /clients/ | writes to newClientsStore (volatile) |
| PATCH /clients/:id | updates newClientsStore (volatile) |
| PATCH /clients/:id/status | updates newClientsStore (volatile) |
| GET/POST /clients/:id/documents | in-memory documentsStore (volatile) |
| GET/POST /clients/:id/files | in-memory filesStore (volatile) |
| POST/PATCH/DELETE /clients/:id/services | in-memory servicesOverrideStore (volatile) |

### In-memory stores (all volatile — die on restart)
- `onlineSessions: OnlineSession[]` — module-level in clients.routes.ts, 8 hardcoded entries
- `servicesOverrideStore: Record<number, Service[]>`
- `documentsStore: Record<number, ClientDoc[]>`
- `filesStore: Record<number, ClientFile[]>`
- `newClientsStore: NewClient[]`
- `deletedClientsStore: Set<number>`

### `shared-stores.ts` (`src/infrastructure/adapters/in-memory/shared-stores.ts`)
Maintains `activeCount/totalCount/newThisMonth` client counters and `openCount/pendingCount` ticket counters.
Dashboard reads these for stats. Must be replaced by Prisma queries once Client model exists.

### Prisma schema — NO `Client` model
Models with loose `clientId: String` (no FK constraint):
`ClientComment`, `Message`, `CreditNote`, `ProformaInvoice`, `FinanceHistoryEvent`,
`VoipCdr`, `RadiusSession`, `CpeDevice`, `OnuDevice`, `Tr069Device`, `IpAssignment`, `ScheduledTask`, `InventoryUnit`

### Catalogs already in Prisma
| Model | Used for filter |
|-------|----------------|
| `ServicePlan` | Plan del cliente |
| `Ubicacion` | Zona geográfica (hierarchical) |
| `Partner` | Partner asignado |
| `NasServer` | NAS asignado |
| `NetworkSite` | Sitio de red |

### Missing catalogs
- `ClientType` (persona/empresa/reseller) — OPEN QUESTION: enum vs table
- Segment (residencial/pyme/corporativo) — OPEN QUESTION: V1 or later?

### Validation
No validation library installed. Only manual `if (!field)` checks in route handlers.

---

## Affected Areas

| File | Why affected |
|------|-------------|
| `prisma/schema.prisma` | New Client model + enums (ClientStatus, ClientType?) |
| `src/domain/entities/customer.ts` | Expand or rename to Client entity |
| `src/domain/ports/CustomerRepository.ts` | Add write methods |
| `src/infrastructure/adapters/splynx/SplynxCustomerAdapter.ts` | Replace with PrismaClientRepository |
| `src/infrastructure/adapters/prisma/PrismaClientRepository.ts` | TO CREATE |
| `src/application/use-cases/CreateClient.ts` | TO CREATE |
| `src/application/use-cases/UpdateClient.ts` | TO CREATE |
| `src/application/use-cases/DeleteClient.ts` | TO CREATE |
| `src/application/use-cases/ChangeClientStatus.ts` | TO CREATE |
| `src/infrastructure/http/routes/clients.routes.ts` | Refactor POST/PATCH/DELETE to use use cases |
| `src/infrastructure/adapters/in-memory/shared-stores.ts` | Eliminate client counters, replace with Prisma queries |
| `src/infrastructure/http/app.ts` | Wire PrismaClientRepository instead of SplynxCustomerAdapter |

---

## Analysis by Front

### a) Prisma Client Model

Proposed fields (union of Splynx + current entity + route body):

```
model Client {
  id          String       @id @default(cuid())
  firstName   String
  lastName    String
  name        String       // computed: stored for search efficiency
  email       String       @unique
  phone       String
  status      ClientStatus @default(active)
  address     String?
  city        String?
  country     String       @default("Argentina")
  login       String?      @unique  // PPPoE username from Splynx
  splynxId    String?      @unique  // preserve for migration compatibility
  clientType  ClientType?           // QUESTION: enum or FK
  notes       String?
  partnerId   String?               // FK to Partner (optional)
  ubicacionId String?               // FK to Ubicacion (optional)
  createdAt   DateTime     @default(now())
  updatedAt   DateTime     @updatedAt
}

enum ClientStatus { active, late, blocked, inactive }
enum ClientType   { persona, empresa, reseller }     // if enum approach
```

**Open question on IDs**: use new `cuid()` or preserve Splynx numeric IDs as strings?
- `cuid()` approach: clean slate, no dependency on Splynx numbering
- Preserve Splynx IDs: easier cross-reference during migration, but breaks UUID convention

**FK migration strategy**: Add FK constraints to related models incrementally via migrations.
Priority order: `ClientComment → CreditNote → ProformaInvoice → RadiusSession → CpeDevice`

### b) Catalogs for filters

| Catalog | Status | Notes |
|---------|--------|-------|
| Status | ✅ will be Prisma enum on Client | |
| ServicePlan | ✅ already in Prisma | |
| Ubicacion | ✅ already in Prisma | FK on Client.ubicacionId |
| Partner | ✅ already in Prisma | FK on Client.partnerId |
| ClientType | MISSING | enum vs table — OPEN QUESTION |
| Segment | MISSING | V1 or later? — OPEN QUESTION |

### c) Validation library comparison

| Library | TS-first | Type inference | Decorators | Bundle | Ecosystem |
|---------|----------|---------------|------------|--------|-----------|
| **zod** | YES | schema→type | no | ~14KB | excellent |
| class-validator | no | manual (class) | YES | ~30KB | good |
| joi | no | manual (@types) | no | ~25KB | mature |
| valibot | YES | schema→type | no | ~8KB | growing |

**RECOMMENDATION: zod**
- Integrates cleanly with hexagonal architecture (schemas live in application/dto or http layer — NOT in domain)
- Excellent TS inference: `z.infer<typeof CreateClientSchema>` produces the DTO type automatically
- No decorators = no class-based DTOs = stays compatible with current interface-based entity pattern
- Battle-tested, large ecosystem, team likely already knows it

### d) Use Cases CRUD

| Use Case | Domain validation (not input) |
|----------|------------------------------|
| `CreateClient` | email uniqueness; login uniqueness if provided |
| `UpdateClient` | email uniqueness (if changed); optimistic concurrency |
| `DeleteClient` | cannot delete if has active services (domain rule) |
| `ChangeClientStatus` | blocked→active requires explicit reason; status transition rules |

Coexistence: existing read use cases (ListClients, GetClientDetail, etc.) continue to use `CustomerRepository` port — no conflict. Once `PrismaClientRepository` implements the expanded port, it replaces `SplynxCustomerAdapter` in `app.ts`.

### e) REST Endpoints

**Keep all existing paths** — no breaking changes to routes.

| Endpoint | Change |
|----------|--------|
| POST /api/clients | wire to CreateClient use case + zod validation |
| PATCH /api/clients/:id | wire to UpdateClient use case |
| DELETE /api/clients/:id | wire to DeleteClient use case |
| PATCH /api/clients/:id/status | wire to ChangeClientStatus use case |
| GET /api/clients/online | migrate to RadiusSession Prisma query |
| DELETE /api/clients/online/:sessionId | update RadiusSession status via Prisma |

**New endpoint**:
- `GET /api/clients/catalogs` — aggregated: `{ statuses, types, partners, ubicaciones, servicePlans }`
  - Single round trip for frontend
  - Frontend loads on mount for filter dropdowns

Documents/Files/Services sub-routes: keep as-is in V1 (still in-memory). Migrate in Change 2.

### f) Migration of shared-stores.ts

| Store | Action |
|-------|--------|
| `sharedClientStore` (counters) | ELIMINATE — replace with `prisma.client.count(...)` in DashboardRepository |
| `sharedTicketStore` (counters) | keep for now (tickets may not have Prisma model yet) |
| `onlineSessions` (in routes) | migrate to `RadiusSession` queries (model already exists in Prisma!) |
| `servicesOverrideStore` | keep volatile in V1, migrate in Change 2 |
| `documentsStore` / `filesStore` | keep volatile in V1, migrate in Change 2 |
| `newClientsStore` / `deletedClientsStore` | ELIMINATE once Client Prisma model exists |

**Note**: `onlineSessions` lives inside `clients.routes.ts` module scope — it is NOT in `shared-stores.ts`. Will be lost when routes are refactored. Can be safely replaced by `RadiusSession` Prisma queries since that model already exists.

### g) Splynx Adapter Replacement

`SplynxCustomerAdapter` provides only read operations. Migration options:

| Option | Approach | Risk |
|--------|----------|------|
| Hard cut | Drop Splynx adapter, all data in Prisma | Requires data import FIRST |
| Parallel | Prisma for writes, Splynx for reads during transition | Complexity, two sources of truth |
| Fallback | Try Prisma first, fallback to Splynx | Hides bugs, confusing behavior |

**RECOMMENDATION**: Hard cut — import data first (Change 2), then eliminate adapter. During Change 1, `PrismaClientRepository` handles only newly created clients; Splynx adapter handles historical clients until import is done.

**OPEN QUESTION**: Are there real clients in Splynx today that must be imported?

---

## Scope Recommendation

### Option C (RECOMMENDED): Two changes

**Change 1: `clients-foundation`**
- Prisma `Client` model + migration
- Expand `CustomerRepository` port with write methods
- `PrismaClientRepository` (full CRUD + reads)
- Use cases: `CreateClient`, `UpdateClient`, `DeleteClient`, `ChangeClientStatus`
- Add zod for input validation on routes
- Refactor POST/PATCH/DELETE routes to use use cases
- `GET /api/clients/catalogs` endpoint
- Wire `app.ts` with `PrismaClientRepository`
- Update `DashboardRepository` to query `Client` counts from Prisma (eliminate `sharedClientStore`)
- Effort: **Medium-High** (1-2 weeks)

**Change 2: `clients-data-migration`**
- Script to import Splynx clients into `Client` Prisma table
- `ClientDocument` + `ClientFile` Prisma models
- `ClientService` Prisma model
- Migrate `onlineSessions` to `RadiusSession` queries
- Wire documents/files/services endpoints to Prisma
- Remove `SplynxCustomerAdapter` entirely
- Effort: **Medium** (depends on Splynx data volume)

**Why not Option A (one big change)**: Too many unknowns (Splynx data, sub-entity models) block foundation work.
**Why not Option B (three small changes)**: Splitting model + validation + catalogs is artificial — they're tightly coupled.

---

## Risks

1. `onlineSessions` is module-level inside `clients.routes.ts` — will be silently dropped when routes are refactored; must migrate to `RadiusSession` before or simultaneously
2. `clientId: String` loose references across 10+ models — FK migration requires verifying no orphaned data (especially `RadiusSession`, `CpeDevice`)
3. `ConvertLeadToClient` sets `convertedClientId: String` on `Lead` without creating a real `Client` — needs coordination once `Client` model exists
4. `DashboardStat` singleton has hardcoded counters — removing `sharedClientStore` breaks dashboard stats until Prisma queries replace them (must be done atomically)
5. `RadiusSession` records already exist with Splynx numeric `clientId` strings — FK constraint addition requires data integrity check first

---

## Open Questions for User

1. **Splynx data**: Are there real clients in Splynx today that must be imported before eliminating the adapter?
2. **Segments**: Do we need client segments (residencial/pyme/corporativo) in V1 or can we postpone?
3. **ClientType**: As a Prisma enum `(persona | empresa | reseller)` or as a `ClientType` table editable from admin?
4. **IDs**: New `cuid()` per Prisma convention or try to preserve Splynx numeric IDs?
5. **Validation library**: Any specific preference or go with the recommendation (zod)?
6. **Scope**: Option C (two changes: foundation + migration) or everything in one?

---

## Ready for Proposal

**YES** — but the orchestrator should pause and get user answers to the 6 questions above before launching `sdd-propose`. Proposal depends especially on questions 1 (data migration urgency), 3 (ClientType model shape), and 4 (ID strategy).
