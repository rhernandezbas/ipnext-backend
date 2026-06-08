# Design: Manual Inventory Item on Task (backlog #19)

## Technical Approach

Approach A from the proposal: new `CreateManualSuggestion` use case behind `POST /scheduling/:taskId/inventory/suggestions`, inserting a `source='MANUAL'` staged suggestion that rides the existing confirm/replace/discard pipeline untouched. Plus two surgical fixes: source pass-through on confirm, and shared completeness validation.

## Architecture Decisions

### Decision 1: Port surface — dedicated `create()`, duplicates allowed, upsert natural key gains `source`

**Choice**: Add to `InventorySuggestionRepository`:

```ts
/** Plain insert — no natural-key dedup. MANUAL entries must never merge into OCR rows. */
create(suggestion: TaskInventorySuggestion): Promise<TaskInventorySuggestion>;
```

- Prisma: `prisma.taskInventorySuggestion.create({ data: {...} })` (same field mapping as the upsert's create branch, via `toEntity`).
- InMemory: `store.set(s.id, s)` WITHOUT registering in `byNatural` — otherwise a later OCR upsert would merge scraped data into the MANUAL row.
- Additionally, add `source` to the upsert natural key in BOTH adapters (Prisma `findFirst` where + InMemory `naturalKey()`): re-ingest idempotency is preserved (same source), but ingest can never clobber/enrich a MANUAL row sharing SN/MAC.

**Duplicate policy**: identical manual suggestions are ALLOWED at staging (no 409). Staging is review-oriented; the contract is already protected at confirm time by `matchInstalledItem` → `DuplicateInstalledItemError` (409). Rejecting at create would need a new error + source-aware lookup for marginal value.

**Alternatives rejected**: reuse `upsert` (source-blind key merges MANUAL into OCR, losing nothing but corrupting provenance and photo data — the exact risk the proposal flags); idempotent-return (hides operator typos behind a silent no-op).

### Decision 2: Shared validation — domain service `assertSuggestionComplete`

**Choice**: New `src/domain/services/suggestionCompleteness.ts` (precedent: `domain/services/passwordPolicy.ts`):

```ts
export function assertSuggestionComplete(
  s: Pick<TaskInventorySuggestion, 'id' | 'kind' | 'serialNumber' | 'mac' | 'materialDesc'>,
): void; // throws IncompleteSuggestionError (messages verbatim from ConfirmInventorySuggestion.assertComplete)
```

`ConfirmInventorySuggestion` deletes its private `assertComplete` and calls this (fail-closed, behavior identical — existing #18 tests stay green). `CreateManualSuggestion` builds the entity (UUID first), then calls it fail-fast before `repo.create()`. Messages stay byte-identical (`'DEVICE requiere SN o MAC'`, `'MATERIAL requiere descripción'`) → zero drift.

**Alternative rejected**: function exported from the entity file — works, but `domain/services/` already exists for cross-use-case domain logic.

### Decision 3: Source pass-through on confirm

Verified: `ContractInstalledItem.source` already holds `'OCR' | 'MANUAL' | 'ICLASS'` (`AddInstalledItemManually` writes `'MANUAL'` today). Suggestion sources written by ingest: `'OCR'`, `'ICLASS_MATERIAL'`; new: `'MANUAL'`.

**Choice**: replace the ternary in BOTH `execute()` (line ~124) and `replace()` (line ~193) of `ConfirmInventorySuggestion` with a private helper:

```ts
const toItemSource = (s: string) => (s === 'OCR' || s === 'MANUAL') ? s : 'ICLASS';
```

**Alternative rejected**: verbatim pass-through — would start writing `'ICLASS_MATERIAL'` onto items, changing today's stored values for the ICLASS path. The map fixes ONLY the MANUAL bug. Update the schema comment on `TaskInventorySuggestion.source` to `OCR | ICLASS_MATERIAL | MANUAL` (no migration — free string).

### Decision 4: Route + DTO contract

`POST /scheduling/:taskId/inventory/suggestions` in `contractInventory.routes.ts`, guard `auth + perms.materialWrite` (already `inventory.write` in app.ts — no perms wiring change). Zod body:

```ts
{ kind: z.enum(['DEVICE','MATERIAL']),
  type: z.string().optional(),          // DEVICE catalog NAME; validated via deviceTypes.isValid → 422 INVALID_ITEM_TYPE, uppercased
  serialNumber: z.string().nullish(), mac: z.string().nullish(),
  materialDesc: z.string().nullish(),
  quantity: z.number().positive().nullish(), unit: z.string().nullish() }
```

Use case `CreateManualSuggestion(suggestions, scheduling, inventory)`: `getTask` → `TaskNotFoundError` (404, already in statusMap); build entity (`status:'pending'`, `source:'MANUAL'`, `qwenDeviceType/photoUrl/confirmedItemId: null`); `assertSuggestionComplete` → 422 `SUGGESTION_INCOMPLETE` (global errorHandler); `repo.create()`; return **`TaskInventorySuggestionDto`** match-enriched (reuse `matchInstalledItem` + `toSuggestionMatch` like `ListTaskInventorySuggestions`) so the FE can append it exactly as GET shapes it. Responses: 201 DTO · 400 `VALIDATION_ERROR` · 403 perm · 404 `TASK_NOT_FOUND` · 422 `SUGGESTION_INCOMPLETE` / `INVALID_ITEM_TYPE`.

### Decision 5: FE — inline collapsible form, panel restructure

**Choice**: new sibling component `ManualSuggestionForm.tsx` (same folder), rendered by `TaskInventorySuggestions` behind an "Agregar ítem" toggle button — NOT a modal (mirrors `SuggestionCard`'s local-`useState` inline-editor pattern; no modal precedent in this panel). Restructure: drop the `all.length === 0` early return; always render a header row with the button inside `<Can permission="inventory.write">`, then either the empty-state `<p>` or the list. Form: kind toggle (DEVICE/MATERIAL); DEVICE → `useDeviceTypes` dropdown + SN + MAC; MATERIAL → `useMaterialTypes` datalist/input + quantity + unit; `incomplete` computed exactly as `SuggestionCard` line 98-100, submit disabled + `incompleteHint` shown (mirrors #18). New `useCreateManualSuggestion(taskId)` in `useServiceInventory.ts`: mutation → `api.createManualSuggestion`, `onSuccess` invalidates `suggestionsKey(taskId)` only (no contract item created yet). On success: reset + collapse form.

## Data Flow

    FE ManualSuggestionForm ──POST /scheduling/:taskId/inventory/suggestions──▶ route (zod + type catalog)
        ──▶ CreateManualSuggestion ──assertSuggestionComplete──▶ suggestions.create() [source=MANUAL, pending]
        ◀── 201 TaskInventorySuggestionDto ── invalidate suggestionsKey ──▶ card appears in pending list
    …later: existing confirm pipeline ──toItemSource('MANUAL')──▶ ContractInstalledItem.source='MANUAL'

## File Changes

| File | Action | Description |
|------|--------|-------------|
| BE `src/domain/ports/InventorySuggestionRepository.ts` | Modify | `create()` |
| BE `src/domain/services/suggestionCompleteness.ts` | Create | `assertSuggestionComplete` |
| BE `src/application/use-cases/CreateManualSuggestion.ts` | Create | Use case |
| BE `src/application/use-cases/ConfirmInventorySuggestion.ts` | Modify | `toItemSource` (execute + replace), use shared validation |
| BE `src/infrastructure/adapters/prisma/PrismaInventorySuggestionRepository.ts` | Modify | `create()`, source in upsert key |
| BE `src/infrastructure/adapters/in-memory/InMemoryInventorySuggestionRepository.ts` | Modify | idem |
| BE `src/infrastructure/http/routes/contractInventory.routes.ts` | Modify | POST route + schema |
| BE `src/infrastructure/http/app.ts` | Modify | wire use case into router factory |
| BE `prisma/schema.prisma` | Modify | source comment only |
| FE `…/components/ManualSuggestionForm.tsx` (+`.module.css`) | Create | inline form |
| FE `…/components/TaskInventorySuggestions.tsx` | Modify | header + button, no early return |
| FE `…/components/SuggestionCard.tsx` | Modify | `sourceLabel`: `'MANUAL' → 'manual'` |
| FE `src/hooks/useServiceInventory.ts` | Modify | `useCreateManualSuggestion` |
| FE `src/api/serviceInventory.api.ts` | Modify | `createManualSuggestion` |
| FE `src/types/serviceInventory.ts` | Modify | `CreateManualSuggestionInput` |

## Testing Strategy

| Layer | What | Approach |
|-------|------|----------|
| BE unit | CreateManualSuggestion (happy DEVICE sn/mac/both, MATERIAL, incomplete→422 code, task 404); confirm/replace source pass-through MANUAL; upsert source-key isolation | `ServiceInventory.test.ts` + in-memory repos (strict TDD: red first) |
| BE integration | POST 201/400/403/404/422 | `serviceInventory.routes.test.ts`, supertest |
| FE | button visible empty+non-empty, hidden sin permiso; form submit + invalidation; MANUAL label | NEW `TaskInventorySuggestions.test.tsx`; extend `SuggestionCard.test.tsx` |

## Migration / Rollout

No migration. Revert = revert two PRs; existing MANUAL rows remain valid strings.

## Open Questions

None.
