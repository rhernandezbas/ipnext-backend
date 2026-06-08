# Tasks: Manual Inventory Item on Task (#19)

## Batch A — Backend

### Phase A1: Domain Foundation

- [x] A1.1 [RED] `suggestionCompleteness.test.ts`: tests for `assertSuggestionComplete` — DEVICE no SN/MAC → `IncompleteSuggestionError`; MATERIAL empty desc → error; DEVICE sn only, mac only, both → pass; MATERIAL with desc → pass (covers scenarios: DEVICE incomplete, MATERIAL incomplete)
- [x] A1.2 [GREEN] Create `src/domain/services/suggestionCompleteness.ts` — export `assertSuggestionComplete`, messages byte-identical to current `ConfirmInventorySuggestion.assertComplete` (`'DEVICE requiere SN o MAC'`, `'MATERIAL requiere descripción'`)
- [x] A1.3 Add `create(suggestion: TaskInventorySuggestion): Promise<TaskInventorySuggestion>` to `src/domain/ports/InventorySuggestionRepository.ts`
- [x] A1.4 Update `prisma/schema.prisma` source comment: `OCR | ICLASS_MATERIAL | MANUAL` (no migration)

### Phase A2: Adapter Implementations

- [x] A2.1 [RED] `ServiceInventory.test.ts`: isolation test — OCR upsert after `create(MANUAL, SN-1)` leaves OCR row unchanged; `create(MANUAL)` adds second row for same natural key (covers: SCEN create() does not clobber upsert rows, MANUAL does not clobber OCR suggestion)
- [x] A2.2 [GREEN] `PrismaInventorySuggestionRepository.ts`: implement `create()` via `prisma.taskInventorySuggestion.create`; add `source` to `findFirst` WHERE in `upsert` natural key
- [x] A2.3 [GREEN] `InMemoryInventorySuggestionRepository.ts`: implement `create()` as `store.set(s.id, s)` without touching `byNatural`; add `source` to `naturalKey()`

### Phase A3: Source Pass-Through Fix

- [x] A3.1 [RED] `ServiceInventory.test.ts`: confirm MANUAL suggestion → item `source='MANUAL'`; confirm OCR → `'OCR'`; confirm ICLASS_MATERIAL → `'ICLASS'` (covers: SCEN-CF-5, SCEN-CF-6, SCEN-CF-7)
- [x] A3.2 [GREEN] `ConfirmInventorySuggestion.ts`: replace ternary in `execute()` (~L124) and `replace()` (~L193) with `toItemSource = (s) => (s==='OCR'||s==='MANUAL') ? s : 'ICLASS'`; delete private `assertComplete`; call `assertSuggestionComplete` instead (covers: SCEN-CF-1, SCEN-CF-5 refactor)

### Phase A4: CreateManualSuggestion Use Case

- [x] A4.1 [RED] `ServiceInventory.test.ts`: DEVICE sn only → pending MANUAL; DEVICE mac only; MATERIAL happy; DEVICE no SN/MAC → `IncompleteSuggestionError` (422 code); unknown `type` → `InvalidItemTypeError` (422); task 404 (covers: DEVICE sn-only, mac-only, MATERIAL happy, DEVICE incomplete, MATERIAL incomplete, Task not found)
- [x] A4.2 [GREEN] Create `src/application/use-cases/CreateManualSuggestion.ts` — `getTask` → 404; validate type via `deviceTypes.isValid`; build entity (`source:'MANUAL'`, `status:'pending'`, nulls for qwen/photo/confirmedItemId`); `assertSuggestionComplete` → 422; `repo.create()`; return `TaskInventorySuggestionDto` enriched via `matchInstalledItem + toSuggestionMatch`

### Phase A5: Route + Wiring

- [x] A5.1 [RED] `serviceInventory.routes.test.ts`: `POST 201` DEVICE; `POST 201` MATERIAL; `POST 400` zod fail; `POST 403` no perm; `POST 404` task missing; `POST 422` SUGGESTION_INCOMPLETE; `POST 422` INVALID_ITEM_TYPE (covers: Forbidden, SCEN-CF-3 analog, all 201 scenarios)
- [x] A5.2 [GREEN] `contractInventory.routes.ts`: add POST `/scheduling/:taskId/inventory/suggestions` with Zod schema (kind, type?, serialNumber?, mac?, materialDesc?, quantity?, unit?); guard `auth + perms.materialWrite`
- [x] A5.3 `src/infrastructure/http/app.ts`: wire `CreateManualSuggestion` into router factory
- [x] A5.4 [VERIFY] `npx tsc --noEmit` + `npx jest --runInBand` — Batch A suite green

---

## Batch B — Frontend

### Phase B1: API + Hook

- [x] B1.1 `src/types/serviceInventory.ts`: add `CreateManualSuggestionInput` type (kind, type?, serialNumber?, mac?, materialDesc?, quantity?, unit?)
- [x] B1.2 `src/api/serviceInventory.api.ts`: add `createManualSuggestion(taskId, input): Promise<TaskInventorySuggestionDto>`
- [x] B1.3 [RED] `TaskInventorySuggestions.test.tsx` (new): hook test — `useCreateManualSuggestion` calls API, on success invalidates `suggestionsKey(taskId)` only
- [x] B1.4 [GREEN] `src/hooks/useServiceInventory.ts`: add `useCreateManualSuggestion(taskId)` — mutation → `api.createManualSuggestion`; `onSuccess`: `invalidateQueries(suggestionsKey(taskId))`

### Phase B2: ManualSuggestionForm Component

- [x] B2.1 [RED] `TaskInventorySuggestions.test.tsx`: form tests — DEVICE fields visible when kind=DEVICE; MATERIAL fields when kind=MATERIAL; submit DEVICE with no SN/MAC shows `incompleteHint`, no API call; successful DEVICE submit calls mutation + collapses form (covers: Form incompleteHint, Form successful DEVICE submission)
- [x] B2.2 [GREEN] Create `src/…/components/ManualSuggestionForm.tsx` — kind toggle; DEVICE: `useDeviceTypes` dropdown + SN + MAC; MATERIAL: materialDesc + quantity + unit; `incomplete` computed mirroring SuggestionCard L98–100; `incompleteHint` shown on failed submit; calls `useCreateManualSuggestion` on valid submit; resets + collapses on success
- [x] B2.3 Create `ManualSuggestionForm.module.css` (scoped styles)

### Phase B3: TaskInventorySuggestions Panel Restructure

- [x] B3.1 [RED] `TaskInventorySuggestions.test.tsx`: button visible in empty state with `inventory.write`; button visible in non-empty state; button NOT rendered without `inventory.write` (covers: Button visible empty, Button visible non-empty, Button hidden without permission)
- [x] B3.2 [GREEN] `TaskInventorySuggestions.tsx`: drop `all.length === 0` early return; always render header row with `<Can permission="inventory.write"><button>Agregar ítem</button></Can>`; toggle `ManualSuggestionForm` inline; render empty-state `<p>` or list conditionally below

### Phase B4: SuggestionCard Source Label

- [x] B4.1 [RED] `SuggestionCard.test.tsx`: suggestion `source='MANUAL'` → badge text `'Manual'` (covers: MANUAL sourceLabel)
- [x] B4.2 [GREEN] `SuggestionCard.tsx`: add `'MANUAL': 'Manual'` to `sourceLabel` map

### Phase B5: Verify

- [x] B5.1 [VERIFY] `npx vitest run` + `npm run typecheck` — Batch B suite green; all 23 scenarios covered
