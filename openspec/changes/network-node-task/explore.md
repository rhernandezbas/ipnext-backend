# Exploration — #29 Network-Only Task ("Tarea de RED")

> A side button (rojo / "RED" = network) in the task creation modal opens a "Tarea de RED" variant.
> That flow does NOT ask for clients or service — ONLY a Nodo (NetworkSite). Everything else stays
> the same (must be sendable to IClass, etc.) — only instead of (service + customer), just a node.

---

## 1. Current state

### Tasks require customer + contract today

The DB already allows null customer/contract, but the **application layer enforces both as required on create**:

- **Prisma model** `ScheduledTask` (`prisma/schema.prisma:876-979`): `customerId String?` (line 901) and `contractId String?` (line 903) are **already NULLABLE**. No DB constraint forces them. There is **no** `networkSiteId`/`nodeId` FK today.
- **Domain entity** `ScheduledTask` (`src/domain/entities/scheduling.ts:30-36`): `customerId`, `customerName`, `customerCity`, `customerPhone`, `customerCode`, `contractId` are all `string | null` already.
- **CreateTask use case** (`src/application/use-cases/CreateTask.ts:23-34`): hard-asserts both — `const cid = data.customerId!` and validates existence; throws `ReferenceNotFoundError`. Comment: "REQ-REQUIRED-1/2: customerId and contractId are always required on create."
- **DTO/zod** `CreateTaskSchema` (`src/application/dto/scheduling.dto.ts:82-89`): `.extend({ customerId: z.string().min(1), contractId: z.string().min(1) })` — REQUIRED. (UpdateTaskSchema is `.partial()`, so update already tolerates null.)
- **Route** `POST /` (`src/infrastructure/http/routes/scheduling.routes.ts:374-441`) validates with `CreateTaskSchema` — no bypass without schema change.
- **Mapper** `toTask()` (`PrismaSchedulingRepository.ts:22-32`): already derives customer* fields from the JOIN with optional chaining, returns null gracefully. **List/Get/Activity-log make no customer assumptions** — zero blast radius for reads.

### IClass send (the part that must keep working)

- **SendTaskToIClass** (`src/application/use-cases/SendTaskToIClass.ts:55-192`): on stage move to "Enviar a IClass", builds the SO. Lines 104-114 validate REQUIRED fields `customerName`, `customerPhone`, `address`, `customerCity`, `description`; missing → `MissingRequiredFieldsError` (422).
- **dispatchTaskToIClass** (`dispatchTaskToIClass.ts:100-110`): maps `customerCode`, `customerName`, `phone`, `address`, `city`, `description`, `soType` (from `Project.iclassSoType.code`), and optional `nodeCode`.
- **IClassClient** (`IClassClient.ts:273-305`): sends `serviceOrder` + `customer` (does inline upsert) + `address`. **Critical line 301**: `nodeCode: input.nodeCode ?? input.city` — there is **already a nodeCode override mechanism** (used by `ResendTaskToIClassWithNode.ts:129-134`). The adapter is already node-aware; it's the application layer that demands customer fields.

### Where node / site entities live

- **NetworkSite** entity = the "Nodo" (`src/domain/entities/networkSite.ts:1-14`): `id`, `name`, `address?`, `city?`, `coordinates`, `type: 'pop'|'nodo'|'datacenter'|'tower'|'other'`, `status`, `deviceCount`, `clientCount`, `uplink`, `parentSiteId`, `description?`. Prisma model at `schema.prisma:1253-1270`.
- **Backend CRUD already exists**: `GET/POST/PUT/DELETE /api/network-sites` (`networkSite.routes.ts:1-56`), use cases `List/Get/Create/Update/DeleteNetworkSite`, `PrismaNetworkSiteRepository`, wired in `app.ts:864-870`.
- **Frontend**: `NetworkSitesPage.tsx` ("Sitios de red") lists them; hook `useNetworkSites` (query key `['network-sites']`), type `src/types/networkSite.ts`. RBAC `network.manage_sites`.

> NOTE: the IClass "node" (`useIClassNodes` / `listIClassNodes`, `scheduling.api.ts:104-117`) is the IClass-side node catalog (matched by normalized name/city). The **NetworkSite** is our internal site catalog. These are TWO different node concepts and the mapping between them is an open question (see §4).

### FE task modal today

- `CreateTaskModal.tsx` (frontend `.../SchedulingTasksPage/components/CreateTaskModal.tsx:87-488`): single form, no tabs. `canSave` (line 203) requires title, project, firstStage, customer, contract, description. CustomerPicker (314-345) + conditional contract select. Submits via `onCreate` → `useCreateTask()` → `api.createTask()`. There is **no node selector** today. IClass send is NOT triggered from the modal — it's a post-creation stage transition.

---

## 2. Gap analysis — what must change for a node-only task

| Layer | Current | Change required |
|-------|---------|-----------------|
| **DB schema** | customer/contract nullable; no node FK | If we link the task to a NetworkSite: add `networkSiteId String?` + relation (migration). If we only need the IClass node *code*, a plain string column may suffice. Possibly a discriminator (`kind: 'customer' \| 'network'`). |
| **Domain entity** | customer fields nullable | Add `networkSiteId / networkSiteName` (+ maybe `kind`) to `ScheduledTask` entity. |
| **CreateTask use case** (`:23-34`) | always validates customer+contract | Gate: `if (kind === 'customer') { validate customer+contract }` else `{ validate networkSiteId exists via NetworkSite lookup }`. Inject a `NetworkSiteRepository` port. |
| **CreateTaskSchema** (`:82-89`) | both `.min(1)` required | Discriminated union OR conditional: when network mode → `customerId/contractId` optional/absent, `networkSiteId` required. |
| **Route** (`:374-441`) | one schema | Reuse schema (preferred) or add `POST /network-tasks`. |
| **IClass send** (`SendTaskToIClass:104-114`) | requires customerName/phone/city/address | For network tasks: substitute customer fields with node-derived values (name = site name, address = site address, city = site city, phone = placeholder/empty, customerCode = a fixed "NETWORK"/site code), and pass explicit `nodeCode` (line 301 override) to bypass city matching. Likely needs a network SO type. The adapter does inline customer upsert and does not check origin, so substituted values flow through. |
| **IClass SO type** (`iclass-so-type.ts`) | Project→one soType; no network type | Decide soType source for a node task (Project still chosen? dedicated network soType?). |
| **FE modal** | customer+contract hardcoded | Add RED side button (mode toggle `'cliente' \| 'nodo'`), swap CustomerPicker+ContractSelect for a `NodeSelector` (fed by `useNetworkSites`), adjust `canSave`, send `{ customerId:null, contractId:null, networkSiteId }`. Reuse same modal — cleaner than a second modal. |

**Safe zone (no change):** mapper `toTask()`, List/Get, UpdateTask (already partial), activity log, GR ingest (always has customer, unaffected).

---

## 3. Approach options

### Option A — Relax existing `ScheduledTask` with a discriminator (RECOMMENDED)
Add `networkSiteId String?` FK + a `kind`/mode field on `ScheduledTask`. Gate validation in CreateTask and the zod schema by mode. IClass send substitutes node-derived values + explicit `nodeCode`. FE = mode toggle inside the existing modal.

- **Pros**: DB/entity/mapper already nullable-ready; minimal new surface; one task list, one Kanban, one detail view; IClass adapter already node-aware (line 301); reuses all read paths. Single source of truth for "tasks".
- **Cons**: `ScheduledTask` grows a conditional shape (customer XOR node); validation branches; care needed so customer-mode invariants don't regress.
- **Effort**: ~MODERATE. Migration (1) + use case/DTO gating (2) + IClass substitution (3) + FE toggle/selector (4) + tests. Roughly 1-1.5 days incl. tests.

### Option B — Separate flow/entity (e.g. `NetworkTask`)
A distinct entity/table + routes + use cases for network tasks.

- **Pros**: clean separation of invariants; no risk to customer-task path; explicit model.
- **Cons**: duplicates list/detail/Kanban/stage/IClass plumbing; two task systems to keep in sync; large blast radius; contradicts "everything else stays the same". High effort, low payoff.
- **Effort**: HIGH (multi-day, lots of duplication).

### Option C (lightweight variant of A) — no FK, store IClass node code as string
Skip the NetworkSite relation; store only a `nodeCode`/`networkNode` string captured from the FE.

- **Pros**: smallest migration; directly feeds IClass line 301.
- **Cons**: no referential integrity to NetworkSite; user explicitly said "associated with the network sites from the network management page", which argues for a real FK.

**Recommendation: Option A.** It honors "everything else stays the same", leverages the already-nullable model and the existing `nodeCode` override, and ties the task to the real NetworkSite catalog the user named. Use a `kind` discriminator to keep validation honest.

---

## 4. Open product questions for the user

1. **Button = mode toggle vs separate modal?** Recommended: a toggle inside the existing `CreateTaskModal` (RED side button flips `cliente`/`nodo`). Confirm you don't want a fully separate modal.
2. **Does a network task still need project + workflow + stage?** "Everything else stays the same" suggests yes (it still flows through stages incl. "Enviar a IClass"). Confirm project is still chosen (it drives the IClass SO type), or whether network tasks use a dedicated SO type.
3. **NetworkSite ↔ IClass node mapping.** We have TWO node concepts: our `NetworkSite` (network management page) and the IClass node catalog (`useIClassNodes`, matched by name/city). When sending a network task to IClass, how do we identify the SO's `nodeCode`? By the NetworkSite name? city? a new explicit mapping field on NetworkSite? This is the central integration question.
4. **IClass customer substitution.** A node SO still hits IClass's customer-upsert path. What should `customerName`/`customerCode`/`phone`/`address`/`city` be for a node task — site name + site address + a fixed "NETWORK" code + empty phone? Is an empty phone accepted by IClass?
5. **Migration.** A `networkSiteId` FK (+ `kind`) needs a Prisma migration. OK to add it (Option A), or do you prefer the string-only lightweight variant (Option C, no migration of a relation)?
6. **Permissions.** Same `scheduling.write`, or a dedicated permission for network tasks?

---

## 5. Size + SDD recommendation

**Size: MODERATE — ~1 to 1.5 days** across backend + frontend incl. tests (migration, CreateTask/DTO gating, IClass substitution + node code, FE toggle + NodeSelector). The model/mapper/read paths are already nullable-ready, which keeps it from being large.

**Warrants SDD: YES (light).** It touches schema (migration), a core use case, the IClass contract, and the FE modal, and it carries real product ambiguities (node↔IClass mapping, customer substitution). A short proposal + spec + design pass is worth it before coding — mostly to lock the open questions in §4, not because the implementation is huge.

### Proposed backlog #29 entry
> **#29 — Tarea de RED (network-only task).** Add a "RED" (red/network) side button to the task creation modal that switches it into a node-only variant: instead of customer + service/contract, the operator picks a Nodo from the NetworkSite catalog (network management page). The task keeps everything else (project, workflow, stages, IClass dispatch). Backend: `ScheduledTask` gains an optional `networkSiteId` FK + a `kind` discriminator; CreateTask use case and zod schema gate customer/contract validation by mode; IClass send substitutes node-derived values and passes an explicit `nodeCode` (override already exists at `IClassClient.ts:301`). Frontend: mode toggle inside `CreateTaskModal`, swapping CustomerPicker+ContractSelect for a NodeSelector backed by `useNetworkSites`. Open questions: NetworkSite↔IClass node mapping, customer-field substitution for the SO, and whether a dedicated SO type/permission is needed. Est. 1-1.5 days; recommend a light SDD pass to lock the product questions first.
