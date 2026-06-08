# Tasks: Network-Node Task ("Tarea de RED") — #29

---

## Batch A — Backend

### Phase A1: Foundation (DB + Domain + Ports)

- [x] A1.1 [RED] Write failing test: migration SQL exists and adds `kind`, `networkSiteId` to `ScheduledTask` and `iclassNodeCode` to `NetworkSite` (schema snapshot test or grep on migration file)
- [x] A1.2 [GREEN] Generate migration SQL via `prisma migrate diff`; create `prisma/migrations/<ts>_network_node_task/migration.sql`; update `prisma/schema.prisma`: `ScheduledTask.kind String @default("customer")`, `networkSiteId String?` (FK SetNull), `@@index([networkSiteId])`; `NetworkSite.iclassNodeCode String?` + back-relation
- [x] A1.3 [GREEN] Update `src/domain/entities/scheduling.ts`: add `kind: 'customer'|'network'`, `networkSiteId: string|null`, `networkSiteName: string|null` — covers REQ-SHAPE-2
- [x] A1.4 [GREEN] Update `src/domain/entities/networkSite.ts`: add `iclassNodeCode: string|null`
- [x] A1.5 [GREEN] Update `src/domain/ports/SchedulingRepository.ts` `CreateTaskInput`: add `kind`, `networkSiteId`
- [x] A1.6 [GREEN] Add `'networkSite'` to `ReferenceKind` in `src/domain/errors/scheduling.ts` — covers REQ-REF-NETWORK-1

### Phase A2: DTO + Validation

- [x] A2.1 [RED] Write failing Zod tests: customer branch rejects missing `contractId`; network branch rejects missing `networkSiteId`; network+customerId combo rejected; valid customer passes; valid network passes — covers REQ-VAL-1 scenarios
- [x] A2.2 [GREEN] Rewrite `CreateTaskSchema` in `src/application/dto/scheduling.dto.ts` as `z.discriminatedUnion('kind', [CustomerTask, NetworkTask])` per design contract

### Phase A3: Use Case — CreateTask

- [x] A3.1 [RED] Write failing unit tests in `src/__tests__/application/CreateTask.test.ts`: network task created with valid `networkSiteId`; non-existent `networkSiteId` throws `ReferenceNotFoundError`; customer branch behavior unchanged — covers REQ-KIND-1, REQ-KIND-2, REQ-KIND-3
- [x] A3.2 [GREEN] Update `src/application/use-cases/CreateTask.ts`: inject `NetworkSiteRepository`; add `kind` branch (network: `getById` + throw if missing; customer: existing assertions unchanged)

### Phase A4: Prisma Adapter Mapping

- [x] A4.1 [RED] Write failing test: `toTask` maps `kind/networkSiteId/networkSiteName`; `_buildCreateData` writes `kind/networkSiteId`; `INCLUDE` contains `networkSite` — covers REQ-SHAPE-2 scenarios
- [x] A4.2 [GREEN] Update `src/infrastructure/adapters/prisma/PrismaSchedulingRepository.ts`: add `networkSite` to `INCLUDE`; map `kind`, `networkSiteId`, `networkSiteName` in `toTask`; write `kind`, `networkSiteId` in `_buildCreateData`

### Phase A5: IClass Dispatch

- [x] A5.1 [RED] Write failing unit tests in `src/__tests__/application/SendTaskToIClass.test.ts`: network task substitutes all fields correctly (`customerName`, `customerCode`, `phone`, `address`, `city`, `nodeCode`); `listNodes()` not called; `iclassNodeCode=null` falls back to `'NETWORK'`; customer task unchanged — covers REQ-NODE-DISPATCH-1, REQ-NODE-DISPATCH-2, REQ-NODE-DISPATCH-3, REQ-PORT-1 scenarios
- [x] A5.2 [GREEN] Update `src/application/use-cases/dispatchTaskToIClass.ts`: add `isNet` branch; substitute fields; pass `nodeCode=site.iclassNodeCode ?? 'NETWORK'`; define `NETWORK_PHONE='0000000000'`, `NETWORK_CUSTOMER_CODE='NETWORK'` constants
- [x] A5.3 [GREEN] Update `src/application/use-cases/SendTaskToIClass.ts`: skip `listNodes()` city lookup when `kind==='network'`; run required-field validation against substituted values

### Phase A6: Route + Wiring

- [x] A6.1 [GREEN] Update `src/infrastructure/http/routes/scheduling.routes.ts`: pass `kind`/`networkSiteId` through; add `REFERENCE_TO_CODE['networkSite'] = 'NETWORK_SITE_NOT_FOUND'`; confirm error handler maps to HTTP 404 — covers REQ-REF-NETWORK-1
- [x] A6.2 [GREEN] Update `src/infrastructure/http/app.ts`: wire `NetworkSiteRepository` into `CreateTask` constructor
- [x] A6.3 [RED] Write integration test in `src/__tests__/infrastructure/scheduling.routes.test.ts`: `POST` network payload → 201 + `kind:'network'`; missing `networkSiteId` → 400; non-existent `networkSiteId` → 404 — covers REQ-KIND-1, REQ-KIND-2, REQ-KIND-3, REQ-SHAPE-2

### Phase A7: Typecheck + Full Verify

- [x] A7.1 Run `npx tsc --noEmit`; fix any type errors
- [x] A7.2 Run `npx jest --runInBand`; confirm all A-batch tests green; confirm no customer-path regressions

---

## Batch B — Frontend

### Phase B1: Types

- [x] B1.1 Update `types/networkSite.ts`: add `iclassNodeCode: string|null`
- [x] B1.2 Update scheduling types: add `kind: 'customer'|'network'`, `networkSiteId: string|null`, `networkSiteName: string|null` to `ScheduledTask`

### Phase B2: NodeSelector Component

- [x] B2.1 [RED] Write failing test: `NodeSelector` renders a list of sites; selects site on click; shows empty state
- [x] B2.2 [GREEN] Create `src/components/NodeSelector.tsx` using `useNetworkSites` hook; list+search; returns `networkSiteId`
- [x] B2.3 [IMPECCABLE] Apply impeccable skill to the RED toggle and NodeSelector: spacing, label hierarchy, selection state, empty-state treatment

### Phase B3: CreateTaskModal — Toggle + Network Payload

- [x] B3.1 [RED] Write failing tests: toggle switches between customer (CustomerPicker+ContractSelect) and network (NodeSelector) views; `canSave` false when network mode has no site; network payload includes `kind:'network'`, `networkSiteId`, no `customerId`/`contractId`
- [x] B3.2 [GREEN] Update `CreateTaskModal.tsx`: RED toggle (customer/network); conditional render; branch `canSave`; build network payload on submit

### Phase B4: Kanban + Task List — RED Badge

- [x] B4.1 [RED] Write failing test: task with `kind:'network'` renders RED badge; `kind:'customer'` has no badge
- [x] B4.2 [GREEN] Update kanban card and task list row: show RED badge when `kind==='network'`
- [x] B4.3 [IMPECCABLE] Apply impeccable skill to the RED badge: color, size, positioning, contrast — must feel intentional, not bolted-on

### Phase B5: NetworkSite Form

- [x] B5.1 [RED] Write failing test: `iclassNodeCode` field renders and submits correctly
- [x] B5.2 [GREEN] Add `iclassNodeCode` text input to NetworkSite create/edit form; wire to submit payload

### Phase B6: Typecheck + Full Verify

- [x] B6.1 Run `npx vitest run`; confirm all B-batch tests green
- [x] B6.2 Run `npm run typecheck`; fix any type errors

---

## Scenario Coverage Map

| Spec Scenario | Tasks |
|---|---|
| REQ-KIND-1: Network task created successfully | A3.1, A3.2, A6.3 |
| REQ-KIND-1: Customer task regression | A3.1, A3.2, A7.2 |
| REQ-KIND-2: Missing networkSiteId → 400 | A2.1, A2.2, A6.3 |
| REQ-KIND-2: Network+customerId rejected | A2.1, A2.2 |
| REQ-KIND-3: Non-existent networkSiteId → 404 | A3.1, A3.2, A6.1, A6.3 |
| REQ-SHAPE-2: Network task exposes kind+site fields | A4.1, A4.2, A6.3 |
| REQ-SHAPE-2: Customer task has kind='customer', null network fields | A4.1, A4.2, A7.2 |
| REQ-VAL-1: Customer schema rejects missing contract | A2.1, A2.2 |
| REQ-VAL-1: Network schema rejects missing networkSiteId | A2.1, A2.2 |
| REQ-REF-NETWORK-1: Full error chain for non-existent networkSiteId | A6.1, A6.3 |
| REQ-NODE-DISPATCH-1: Network task dispatched with node-derived fields | A5.1, A5.2 |
| REQ-NODE-DISPATCH-1: Customer task dispatch unchanged | A5.1, A5.3 |
| REQ-NODE-DISPATCH-2: Complete site data passes validation | A5.1, A5.3 |
| REQ-NODE-DISPATCH-2: Substitution runs before null check | A5.1, A5.3 |
| REQ-NODE-DISPATCH-3: null iclassNodeCode uses 'NETWORK' fallback | A5.1, A5.2 |
| REQ-PORT-1: nodeCode override bypasses listNodes; absent falls through | A5.1, A5.2, A5.3 |
