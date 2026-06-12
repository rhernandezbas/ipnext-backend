# Design: node-task-required-locality (#54)

## Decision: task-level snapshot with site fallback
Locality is a per-task snapshot column `iclassCityCode String?`. Required on create for network tasks; dispatch prefers the snapshot over the site, so an operator can override the locality without mutating the site, and legacy tasks (snapshot null) keep working via the site fallback. Additive migration, NO backfill.

### Consistency note
`NetworkSite.city` is a free-text LOCALITY string (e.g. "Mercedes") sent to IClass as the OS `city`. The IClass node `code` values ARE these localities (the customer dispatch path matches city→node.code). So `iclassCityCode` stores a node CODE string, identical in kind to what `NetworkSite.city` already holds. `iclassNodeCode` (e.g. TN-001) is a SEPARATE field and is unchanged.

## Migration
`prisma/migrations/20260701000000_scheduled_task_iclass_city_code/migration.sql`:
```sql
ALTER TABLE "ScheduledTask" ADD COLUMN "iclassCityCode" TEXT;
```
Purely additive, nullable, no default, no data migration, no BEGIN/COMMIT. Timestamp after the latest (20260630000000). Generated via `prisma migrate diff` (never `migrate dev`).

## Backend seam
- `domain/entities/scheduling.ts`: `iclassCityCode: string | null` on ScheduledTask.
- `domain/ports/SchedulingRepository.ts`: `iclassCityCode` omitted from CreateTaskInput's base Omit then re-declared `iclassCityCode?: string | null` (mirrors networkSiteId/grOrdenId). UpdateTaskInput inherits via Partial.
- `application/dto/scheduling.dto.ts`: `iclassCityCode: z.string().nullable().optional()` on CreateTaskBaseSchema (permissive; REQUIRED is a domain 422 guard, mirroring #53 address).
- `domain/errors/scheduling.ts`: `NetworkTaskLocalityRequiredError`, code `NETWORK_TASK_LOCALITY_REQUIRED` (mirror NetworkTaskAddressRequiredError).
- `application/use-cases/CreateTask.ts`: in the network branch, after the #53 address guard, throw when iclassCityCode blank.
- `application/use-cases/UpdateTask.ts`: fire only when `'iclassCityCode' in data && data.iclassCityCode !== undefined` AND new value blank AND existing task.kind==='network'.
- `infrastructure/http/middleware/errorHandler.ts`: `NETWORK_TASK_LOCALITY_REQUIRED: 422`.
- `infrastructure/http/routes/scheduling.routes.ts`: in-route 422 catch in POST+PUT (mirror #53); POST `normalized` passes `iclassCityCode: data.iclassCityCode ?? null`.

## Dispatch precedence (CRITICAL — two sites)
- `application/use-cases/SendTaskToIClass.ts` network validation path: `effectiveCity = task.iclassCityCode ?? networkSite?.city ?? null`.
- `application/use-cases/dispatchTaskToIClass.ts` (SHARED helper used by SendTaskToIClass AND ResendTaskToIClassWithNode) has its OWN effectiveCity computation — it MUST apply the same precedence, else the OS is created with the old site.city while validation used the new value. Both updated.

## Repos
- InMemorySchedulingRepository: iclassCityCode in NEW_FIELDS_DEFAULTS (null), createTask, updateTask, mapping.
- PrismaSchedulingRepository: iclassCityCode in toTask mapping, _buildCreateData, _buildUpdateData.

## Wire contract (BE → FE), field by field
- ScheduledTask gains `iclassCityCode: string | null`.
- POST /api/scheduling/tasks: body accepts `iclassCityCode?: string|null`; kind=network + blank → 422 `{ error, code: "NETWORK_TASK_LOCALITY_REQUIRED" }`.
- PUT /api/scheduling/tasks/:id: blanking iclassCityCode on a network task → same 422.
- Dispatch city = `task.iclassCityCode ?? networkSite.city ?? null`.

## Frontend seam
- CreateTaskModal: required "Localidad" select (network only), options = IClass nodes where active && selectable, value/label = node.code. Default from selected site.city (ref-guarded, mirrors the address autofill); if site.city isn't an eligible option it is shown as a selected fallback option so the select reflects the stored locality. canSave network arm adds `!!iclassCityCode && iclassCityCode.trim()`. Payload network branch sends `iclassCityCode: iclassCityCode || null`. Customer payload unchanged. types/scheduling.ts: CreateTaskPayload `iclassCityCode?: string|null`, ScheduledTask `iclassCityCode: string|null`.

## Test seam
- CreateTask.locality-guard / UpdateTask.locality-guard (mirror #53 address tests).
- SendTaskToIClass.locality-precedence: (a) snapshot set + different site.city → OS city = snapshot; (b) snapshot null + site.city set → OS city = site.city (back-compat); (c) both null → MissingRequiredFieldsError includes 'city'.
- Route: POST kind=network without iclassCityCode → 422 NETWORK_TASK_LOCALITY_REQUIRED.
- Existing network fixtures updated to include iclassCityCode (kind-guard, address-guard, CreateTask.test, network.routes).
- FE: dropdown present/required, select enables canSave, clearing disables, payload carries code, default-from-site preselect, customer regression.

## Back-compat
Additive column, no backfill. Old network tasks (iclassCityCode null) dispatch via site.city fallback exactly as before.

## Accepted divergence: node ↔ city (#53/#54 review)
When the operator picks a locality (`iclassCityCode`) that differs from the node implied by the selected site, the OS is created with the SITE's `nodeCode` while the `city` is overridden by the chosen locality. This node↔city mismatch is **ACCEPTED** as an intentional decision: the semantics of these codes change in the upcoming #51/#55 work (node code resolution is being reworked), so hard-coupling locality to node now would be premature. Dispatch precedence stays `task.iclassCityCode ?? networkSite.city` — the snapshot wins, the node is independent.

### Tech debt (tracked)
- **Locality not editable post-create from the detail page.** The detail PUT echoes `iclassCityCode`, and the guard (fixed in the #53/#54 wave) now only rejects *clearing* an existing value — but there is no UI affordance on the detail page to CHANGE the locality of an existing network task. Operators can only set it at create time. Editing requires a dedicated control on the detail view; deferred to a follow-up (likely alongside #51/#55).
