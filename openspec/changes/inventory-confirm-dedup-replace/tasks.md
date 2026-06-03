# Tasks — inventory-confirm-dedup-replace

> TDD-ordered, dependency-gated. Each batch is an independent apply unit.  
> Tags: [BE] = ipnext-backend · [FE] = ipnext-frontend · [TEST] = write the failing test first.  
> Strict TDD: red → green → refactor. No implementation without a failing test.

---

## Batch 1 — BE: Matcher extraction + ListTaskInventorySuggestions refactor

_Goal: extract the shared pure matcher, keep List behavior 100% unchanged, harden active-only filter._

### 1.1 [TEST][BE] Unit tests for `matchInstalledItem` helper
- **File:** `src/__tests__/application/matchInstalledItem.test.ts` (NEW)
- Write failing tests covering (F1-1 … F1-6):
  - `normSn`: `'  abc123  '` → `'ABC123'`; `''` / `null` → `null`.
  - `normMac`: `'aa:bb:cc:dd:ee:ff'` → `'AABBCCDDEEFF'`; `'AA-BB-CC'` → `'AABBCC'`; `''` → `null`.
  - MATERIAL suggestion → `{ status: null, item: null }` (no list read needed).
  - `same_device` by SN; `same_device` by MAC; precedence: SN-match wins over same-type match.
  - `same_type` when SN differs but type matches.
  - No match → `{ status: null, item: null }`.
  - Active-only: item with `status='replaced'` is NOT matched even if type matches; item with `status='removed'` is NOT matched.
  - `toSuggestionMatch`: `MatchResult { status: null }` → `null`; with item → `{ status, itemId, serial }`.
- All tests MUST fail (helper does not exist yet).

### 1.2 [BE] Implement `matchInstalledItem` helper
- **File:** `src/application/services/matchInstalledItem.ts` (NEW)
- Export `normSn`, `normMac`, `MatchResult`, `matchInstalledItem`, `toSuggestionMatch` exactly as specified in design §1.
- `MatchResult = { status: 'same_device' | 'same_type' | null; item: ContractInstalledItem | null }`.
- `toSuggestionMatch` maps to the existing `SuggestionMatch` DTO (shape unchanged).
- Run tests from 1.1 → all green.

### 1.3 [TEST][BE] Extend `ListTaskInventorySuggestions` test for active-only filter regression
- **File:** `src/__tests__/application/ListTaskInventorySuggestionsMatch.test.ts` (EXTEND)
- Add a failing scenario: contract has one `active` item and one `replaced` item of the same type; suggestion should return `same_type` for the active one only; a suggestion matching only the `replaced` item must return `match: null`.
- All pre-existing tests MUST still pass (no modification to them required).

### 1.4 [BE] Refactor `ListTaskInventorySuggestions` to use the helper
- **File:** `src/application/use-cases/ListTaskInventorySuggestions.ts` (EDIT)
- Delete local `normSn`, `normMac`, `computeMatch` (lines 14-56 approx).
- Import `matchInstalledItem`, `toSuggestionMatch` from `@application/services/matchInstalledItem`.
- Change active-items filter from `i.status !== 'removed'` to `i.status === 'active'` (whitelist).
- Wire: `toTaskInventorySuggestionDto(s, toSuggestionMatch(matchInstalledItem(s, items)))`.
- All tests from 1.1, 1.3, and the pre-existing `ListTaskInventorySuggestionsMatch.test.ts` must be green. No behavior change for data without `replaced` items (non-breaking in prod).

---

## Batch 2 — BE: Domain model — `replacesItemId` + migration + entity + adapters

_Goal: add the self-relation field end-to-end: schema → entity → Prisma adapter._

### 2.1 [TEST][BE] Test that `ContractInstalledItem` entity exposes `replacesItemId`
- **File:** `src/__tests__/application/InMemoryContractInventoryRepository.test.ts` (EXTEND) or the relevant domain test.
- Add failing test: create an item with `replacesItemId: 'some-id'`; read it back; assert `item.replacesItemId === 'some-id'`. Create with no `replacesItemId`; assert `item.replacesItemId === null`.
- Test MUST fail (field does not exist yet).

### 2.2 [BE] Add `replacesItemId: string | null` to the entity
- **File:** `src/domain/entities/contract-installed-item.ts` (EDIT)
- Add `replacesItemId: string | null;` field (additive, F3-1).
- No existing field renamed or removed.

### 2.3 [BE] Generate Prisma migration
- **File:** `prisma/schema.prisma` (EDIT) + new migration dir
- Add to `ContractInstalledItem` model (design §3):
  ```prisma
  replacesItemId String?
  replaces       ContractInstalledItem?  @relation("ItemReplacement", fields: [replacesItemId], references: [id], onDelete: SetNull)
  replacedBy     ContractInstalledItem[] @relation("ItemReplacement")
  @@index([replacesItemId])
  ```
- Run `npm run prisma:migrate -- --name add_installed_item_replaces` to generate migration `20260604110000_add_installed_item_replaces`. Migration MUST be additive: only `ADD COLUMN` + index + FK; no existing column altered/dropped.

### 2.4 [BE] Update `PrismaContractInventoryRepository` to map `replacesItemId`
- **File:** `src/infrastructure/adapters/prisma/PrismaContractInventoryRepository.ts` (EDIT)
- Add `replacesItemId` to `Row` type.
- Add to `toEntity`: `replacesItemId: row.replacesItemId ?? null`.
- Add to `create.data`: `replacesItemId: item.replacesItemId ?? null`.
- `update` does NOT need to accept `replacesItemId` (only set on create; soft-retire uses `status`).
- In-memory adapter (`InMemoryContractInventoryRepository.ts`): no change needed (generic spread already handles new fields — verify no explicit field list blocks it).
- Tests from 2.1 must be green.

---

## Batch 3 — BE: New domain errors + `ConfirmInventorySuggestion` resolution + `replace()` method

_Goal: confirm enforces dedup (409), supports link_existing, and gains a dedicated replace() method._

### 3.1 [TEST][BE] New domain error tests
- **File:** `src/__tests__/domain/errors.test.ts` (EXTEND)
- Add failing tests:
  - `DuplicateInstalledItemError`: `error.code === 'DUPLICATE_INSTALLED_ITEM'`; `error instanceof DomainError`.
  - `NoReplaceTargetError`: `error.code === 'NO_REPLACE_TARGET'`; `error instanceof DomainError`.
- Tests MUST fail (errors not declared yet).

### 3.2 [BE] Declare new domain errors
- **File:** `src/domain/errors/inventory.ts` (EDIT)
- Add `DuplicateInstalledItemError` and `NoReplaceTargetError` as specified in design §2.
- Tests from 3.1 must be green.

### 3.3 [TEST][BE] Extend `ConfirmInventorySuggestion` unit tests — resolution matrix
- **File:** `src/__tests__/application/ServiceInventory.test.ts` (EXTEND)
- Write failing tests for each cell in the matrix (design §6.3 / spec F2):

| # | Seed | Input | Expected |
|---|------|-------|----------|
| A | active item SN=R1; suggestion SN=R1 | `execute({ resolution: 'add' })` | throws `DUPLICATE_INSTALLED_ITEM`; inventory unchanged (still 1 item) |
| B | active item MAC=AABBCC; suggestion MAC=AA:BB:CC | `execute({ resolution: 'add' })` (no resolution field) | throws `DUPLICATE_INSTALLED_ITEM` |
| C | active item SN=R1; suggestion SN=R1 | `execute({ resolution: 'link_existing' })` | `inventory.create` NOT called; `setStatus(confirmed, existing.id)`; result DTO = existing item |
| D | active ROUTER SN=R1; suggestion ROUTER SN=R2 | `execute({ resolution: 'add' })` | creates 2nd item; both active; new `replacesItemId=null` |
| E | active ROUTER SN=R1; suggestion ROUTER SN=R2 | `replace({ ... })` | old → `status:'replaced'`; new active with `replacesItemId=old.id`; suggestion confirmed with new.id |
| F | empty inventory | `execute({})` (no resolution, no match) | creates item (retrocompat; existing tests pass unchanged) |
| G | empty inventory | `replace({ ... })` | throws `NO_REPLACE_TARGET` |
| H | only `replaced`-status item of same type | `replace({ ... })` | throws `NO_REPLACE_TARGET` (replaced item invisible to matcher) |
| I | suggestion MATERIAL | `execute({ resolution: 'add' })` | material path unchanged |
| J | active ROUTER SN=R1; suggestion ROUTER SN=R2 | `replace({ typeOverride: 'ANTENA' })` | new item type=ANTENA; suggestion deviceType persisted |

- All tests MUST fail before touching the use case.

### 3.4 [BE] Implement `resolution` logic in `ConfirmInventorySuggestion.execute`
- **File:** `src/application/use-cases/ConfirmInventorySuggestion.ts` (EDIT)
- Update `ConfirmInventorySuggestionInput`: add `resolution?: 'add' | 'replace' | 'link_existing'`.
- Add `SuggestionResolution` type export.
- Active-items filter: `i.status === 'active'` (same whitelist as List).
- DEVICE branch: recalculate match server-side using `matchInstalledItem`; route through the table (design §2). Note: `resolution='replace'` handled by reject — the route schema prevents this reaching `execute()`; add defensive throw if needed.
- Add `replacesItemId: null` to the existing `create` call (for `add` path).
- MATERIAL branch: unchanged.
- Tests from 3.3 (cases A–D, F, I, J for execute) MUST be green.

### 3.5 [BE] Implement `replace()` method on `ConfirmInventorySuggestion`
- **File:** `src/application/use-cases/ConfirmInventorySuggestion.ts` (EDIT, same file)
- Add `async replace(input: { suggestionId, addedByUserId?, typeOverride? }): Promise<ConfirmResult>` method as designed in §2.
- Logic: guard (not found, already confirmed, not DEVICE, no contractId), active-only items, match; reject if `match.status !== 'same_type'` → `NoReplaceTargetError`; retire old (`update → replaced`), create new with `replacesItemId`, setStatus.
- Tests from 3.3 (cases E, G, H, J for replace) MUST be green.
- All pre-existing `ConfirmInventorySuggestion` tests MUST remain green.

---

## Batch 4 — BE: Routes — confirm resolution, replace route, errorHandler

_Goal: HTTP layer enforces split, gates permissions, maps new error codes._

### 4.1 [TEST][BE] Extend route tests for confirm resolution + replace route
- **File:** `src/__tests__/infrastructure/serviceInventory.routes.test.ts` (EXTEND)
- Write failing supertest cases (design §6.4 / spec F4):

| # | Request | Setup | Expected |
|---|---------|-------|---------|
| R1 | `POST .../confirm` body `{ resolution: 'add' }` | no same-device conflict | 201, item created |
| R2 | `POST .../confirm` body `{ resolution: 'link_existing' }`, seed same-device | same-device active | 201, existing item DTO returned, no new item |
| R3 | `POST .../confirm` no resolution, seed same-device | same-device active | 409, `code: 'DUPLICATE_INSTALLED_ITEM'` |
| R4 | `POST .../confirm` body `{ resolution: 'replace' }` | any | 400, `code: 'VALIDATION_ERROR'` (zod rejects enum) |
| R5 | `POST .../replace` with `contractWrite=deny` | deny middleware | 403 |
| R6 | `POST .../replace` with `contractWrite=pass`, seed same-type | same-type active | 201, old replaced, new with `replacesItemId` |
| R7 | `POST .../replace` with `contractWrite=pass`, no match | empty inventory | 409, `code: 'NO_REPLACE_TARGET'` |

- Ensure helper to build app with selective `deny` for `contractWrite` is available (or add it).
- All tests MUST fail before route changes.

### 4.2 [BE] Update confirm route to accept `resolution` + add replace route
- **File:** `src/infrastructure/http/routes/contractInventory.routes.ts` (EDIT)
- Confirm route `ConfirmSchema`: `resolution: z.enum(['add', 'link_existing']).optional()`. `'replace'` absent from enum → zod returns `400 VALIDATION_ERROR` (spec F4-2).
- Pass `resolution: parsed.data.resolution ?? 'add'` to `confirm.execute(...)`.
- New route `POST .../replace` gated `auth, perms.contractWrite`; `ReplaceSchema: z.object({ type: z.string().optional() })`; calls `confirm.replace(...)`.
- No change to `createContractInventoryRouter` function signature; no change to `app.ts` wiring (same `confirm` instance, same `perms.contractWrite` already available).

### 4.3 [BE] Update `errorHandler` status map
- **File:** `src/infrastructure/http/middleware/errorHandler.ts` (EDIT)
- Add to `statusMap` (design §4):
  ```ts
  DUPLICATE_INSTALLED_ITEM: 409,
  NO_REPLACE_TARGET: 409,
  ```
- Tests R3, R7 from 4.1 MUST be green.

---

## Batch 5 — FE: API + hooks + SuggestionCard buttons + tests

_Goal: FE calls correct endpoints with correct payloads, renders buttons by match, degrades gracefully._

### 5.1 [TEST][FE] Extend `SuggestionCard` tests — buttons by match
- **File:** `src/__tests__/scheduling/SuggestionCard.test.tsx` (EXTEND) AND/OR `src/pages/scheduling/SchedulingTaskDetailPage/components/SuggestionCard.test.tsx` (EXTEND)
- Write failing tests (spec F5):

| # | Props | Expected render |
|---|-------|----------------|
| S1 | pending DEVICE, `match.status='same_device'` | "Marcar como ya instalado" present; "Confirmar" NOT present |
| S2 | click "Marcar como ya instalado" | `onLinkExisting(s.id)` called |
| S3 | pending DEVICE, `match.status='same_type'`, user has `inventory.write` | "Agregar" present; "Reemplazar la actual" present |
| S4 | pending DEVICE, `match.status='same_type'`, user WITHOUT `inventory.write` | "Agregar" present; "Reemplazar la actual" NOT present |
| S5 | click "Agregar" (same_type) | `onConfirm(s.id, type)` called |
| S6 | click "Reemplazar la actual" | `onReplace(s.id, type)` called |
| S7 | pending DEVICE, `match=null` / `match=undefined` | "Confirmar" present; "Marcar como ya instalado" NOT present; "Reemplazar la actual" NOT present |
| S8 | pending DEVICE, `match.status='same_device'` | "Descartar" still present |

- Mock `useMyPermissions` to control `inventory.write` availability.
- All tests MUST fail before implementation.

### 5.2 [TEST][FE] Extend hook tests for `useConfirmSuggestion` + new `useReplaceSuggestion`
- **File:** `src/__tests__/hooks/useServiceInventory.test.ts` (NEW) or nearest hook test file
- Write failing tests:
  - `useConfirmSuggestion` called with `resolution: 'link_existing'` fires request with that resolution in body.
  - `useConfirmSuggestion` `onSuccess` invalidates `suggestionsKey(taskId)` AND `itemsKey(contractId)`.
  - `useReplaceSuggestion` fires `POST .../replace` (not `.../confirm`).
  - `useReplaceSuggestion` `onSuccess` invalidates `suggestionsKey(taskId)` AND `itemsKey(contractId)`.

### 5.3 [FE] Update `serviceInventory.api.ts`
- **File:** `src/api/serviceInventory.api.ts` (EDIT)
- `confirmInventorySuggestion`: add optional `opts?: { type?: InstalledItemType; resolution?: 'add' | 'link_existing' }`.
- Add `replaceInventorySuggestion(taskId, suggestionId, type?)` → `POST .../replace` (design §5).
- No existing call signatures broken (opts is optional, additive).

### 5.4 [FE] Update `useServiceInventory.ts`
- **File:** `src/hooks/useServiceInventory.ts` (EDIT)
- `useConfirmSuggestion`: `mutationFn` gains `resolution?: 'add' | 'link_existing'` in its arg type; passes to `api.confirmInventorySuggestion`.
- Add `useReplaceSuggestion(taskId, contractId?)` mutation → calls `api.replaceInventorySuggestion`; invalidates `suggestionsKey(taskId)` + `itemsKey(contractId)`.
- Tests from 5.2 MUST be green.

### 5.5 [FE] Update `SuggestionCard.tsx` — render buttons by match
- **File:** `src/pages/scheduling/SchedulingTaskDetailPage/components/SuggestionCard.tsx` (EDIT)
- Add props `onLinkExisting?: (id: string) => void` and `onReplace?: (id: string, type?: string) => void`.
- In the pending DEVICE action zone, branch on `s.match?.status` (design §5):
  - `'same_device'` → "Marcar como ya instalado" (`onLinkExisting`) + "Descartar". No "Confirmar".
  - `'same_type'` → "Agregar" (`onConfirm`, add) + `<Can permission="inventory.write">"Reemplazar la actual"</Can>` (`onReplace`) + "Descartar". No "Confirmar".
  - `undefined`/`null` → "Confirmar" (`onConfirm`, add) + "Descartar" (unchanged, degrades gracefully).
- Tests from 5.1 MUST be green.

### 5.6 [FE] Wire new actions in `TaskInventorySuggestions.tsx`
- **File:** `src/pages/scheduling/SchedulingTaskDetailPage/components/TaskInventorySuggestions.tsx` (EDIT)
- Instantiate `const replaceMutation = useReplaceSuggestion(taskId, contractId)`.
- Pass to `SuggestionCard`:
  - `onConfirm={(id, type) => confirm.mutate({ suggestionId: id, type, resolution: 'add' })}` 
  - `onLinkExisting={(id) => confirm.mutate({ suggestionId: id, resolution: 'link_existing' })}` 
  - `onReplace={(id, type) => replaceMutation.mutate({ suggestionId: id, type })}` 
- `isPending` guard: `confirm.isPending || discard.isPending || replaceMutation.isPending`.

### 5.7 [TEST][FE] Error display on 409 DUPLICATE_INSTALLED_ITEM
- **File:** extend nearest confirm-related test or add to `SuggestionCard.test.tsx`
- Write failing test: when `confirmInventorySuggestion` rejects with `{ code: 'DUPLICATE_INSTALLED_ITEM' }`, an error notification/message is visible to the user (spec F5-8).
- Implement error handling in `useConfirmSuggestion.onError` or in `TaskInventorySuggestions.tsx` if not already wired.

---

## Batch 6 — Verify: tsc + jest + vitest pass, no regressions

_Goal: full suite clean on both repos._

### 6.1 [BE] TypeScript compile check
- Run `npx tsc --noEmit` in `ipnext-backend`.
- Fix any type errors introduced by `replacesItemId`, new errors, new method signatures.
- No build output (CLAUDE.md rule: `npm run build` only when user decides).

### 6.2 [BE] Full Jest suite
- Run `npm test` in `ipnext-backend`.
- All pre-existing tests MUST pass; all new tests from B1–B4 MUST be green.
- Zero regressions on `ListTaskInventorySuggestionsMatch`, `ServiceInventory`, `serviceInventory.routes`, `domain/errors` suites.

### 6.3 [FE] TypeScript compile check
- Run `npx tsc --noEmit` in `ipnext-frontend`.
- Fix any type errors on updated hook signatures, new props, new API functions.

### 6.4 [FE] Full Vitest suite
- Run vitest in `ipnext-frontend`.
- All pre-existing tests MUST pass; new tests from B5 MUST be green.
- Zero regressions on `SuggestionCard`, `SchedulingTaskDetailPage`, `useServiceInventory` suites.

---

## Summary

### File count estimate

**BE (ipnext-backend):**
| File | Action |
|------|--------|
| `src/application/services/matchInstalledItem.ts` | NEW |
| `src/__tests__/application/matchInstalledItem.test.ts` | NEW |
| `src/__tests__/application/ListTaskInventorySuggestionsMatch.test.ts` | EXTEND |
| `src/__tests__/application/ServiceInventory.test.ts` | EXTEND |
| `src/__tests__/domain/errors.test.ts` | EXTEND |
| `src/__tests__/infrastructure/serviceInventory.routes.test.ts` | EXTEND |
| `src/application/use-cases/ListTaskInventorySuggestions.ts` | EDIT |
| `src/application/use-cases/ConfirmInventorySuggestion.ts` | EDIT |
| `src/domain/entities/contract-installed-item.ts` | EDIT |
| `src/domain/errors/inventory.ts` | EDIT |
| `src/infrastructure/adapters/prisma/PrismaContractInventoryRepository.ts` | EDIT |
| `src/infrastructure/http/routes/contractInventory.routes.ts` | EDIT |
| `src/infrastructure/http/middleware/errorHandler.ts` | EDIT |
| `prisma/schema.prisma` | EDIT |
| `prisma/migrations/20260604110000_add_installed_item_replaces/migration.sql` | NEW (generated) |

Total BE: **15 files** (2 new + 1 generated + 12 edits)

**FE (ipnext-frontend):**
| File | Action |
|------|--------|
| `src/api/serviceInventory.api.ts` | EDIT |
| `src/hooks/useServiceInventory.ts` | EDIT |
| `src/pages/scheduling/SchedulingTaskDetailPage/components/SuggestionCard.tsx` | EDIT |
| `src/pages/scheduling/SchedulingTaskDetailPage/components/TaskInventorySuggestions.tsx` | EDIT |
| `src/__tests__/scheduling/SuggestionCard.test.tsx` | EXTEND |
| `src/__tests__/hooks/useServiceInventory.test.ts` | NEW (or extend nearest) |

Total FE: **6 files** (1 new + 5 edits)

**Grand total: ~21 files across 2 repos.**

---

### Recommended batch grouping for apply

```
B1 → B2 → B3 → B4 → B5 → B6
```

- **B1** and **B2** are independent and can run in parallel (matcher extraction touches only application/; migration touches only domain+infra+schema).
- **B3** depends on B1 (uses the helper) and B2 (uses the field).
- **B4** depends on B3 (routes call the updated use case).
- **B5** can start once B4 is merged to main (FE degrades safely before that, but tests need the correct API shape).
- **B6** is the final gate: tsc + full suite on both repos.

### Hotspot reminders

- Matcher extraction MUST NOT change `ListTaskInventorySuggestions` observable behavior (F1-7). Validate with the existing `ListTaskInventorySuggestionsMatch.test.ts` suite.
- The `active-only` filter change (`=== 'active'`) is technically a behavior change but a safe no-op on current prod data. Cover it explicitly in the List test (task 1.3).
- The confirm route MUST reject `resolution='replace'` via zod (400), not via a domain exception. The route schema is the single enforcement point (F4-2).
- `replace()` atomicity: retire first, create second. If create fails, a `replaced` item without a successor is the tolerable state. Never create first (would produce two active items on update failure).
- `SuggestionMatch` DTO shape is UNCHANGED — `toSuggestionMatch` reduces `MatchResult` to the existing `{ status, itemId, serial }`. FE wire format is untouched.
- `perms.contractWrite` is already wired in `app.ts:1052`. Zero DI interface changes for the replace route.
