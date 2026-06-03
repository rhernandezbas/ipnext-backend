# Tasks — inventory-edit-and-match

> TDD-ordered, batched task breakdown.  
> Strict TDD: a **failing test must exist before each implementation step**.  
> Tags: [BE] backend · [FE] frontend · [TEST] test-only step.  
> Batches are independent within a phase; across phases they respect the dependency graph.  
> Hotspots are called out inline with ⚠️.

---

## Dependency graph

```
B1 (errors + use-case CorrectConfirmedDeviceType)
  └─► B2 (route + DI + 2 call-site fixes)
        └─► B3 (ListTaskInventorySuggestions enrichment + computeMatch)
              └─► B4 (FE F1: types + api + hook + SuggestionCard editor + contractId threading)
                    └─► B5 (FE F2: match badge)
                          └─► B6 (verify: tsc + jest + vitest)
```

Migrations: **none**. Gate: push (user-confirmed).

---

## B1 — BE: Domain errors + `CorrectConfirmedDeviceType` use-case

> Everything in this batch can be written and tested without touching routes or DI.

### 1.1 [TEST] Red: `CorrectConfirmedDeviceType` test file skeleton

Write `src/__tests__/application/CorrectConfirmedDeviceType.test.ts` with all test cases as `it.todo` or failing stubs. Do NOT implement the use-case yet. Import paths must compile (use-case file may not exist — accept the compile error as the intended red state).

Test cases to scaffold (mirrors spec F1-1 through F1-5 and design AD-12):

- `happy path — updates both suggestion.deviceType and item.type`
- `guard: suggestionId not found → SUGGESTION_NOT_FOUND`
- `guard: suggestion is pending (not confirmed) → SUGGESTION_NOT_CONFIRMED`
- `guard: suggestion is MATERIAL (not DEVICE) → SUGGESTION_NOT_A_DEVICE`
- `guard: confirmedItemId is null (dirty data) → SUGGESTION_NOT_LINKED`
- `guard: confirmedItemId points to deleted item → INSTALLED_ITEM_NOT_FOUND`
- `return value: returns InstalledItemDto (addedByUserName null)`
- `normalisation: use-case receives already-normalised UPPERCASE type (e.g. ANTENA) and persists it as-is`

Setup pattern: reuse `InMemoryInventorySuggestionRepository` + `InMemoryContractInventoryRepository` (same as `ServiceInventory.test.ts:29-46`).

### 1.2 [BE] Add domain errors to `src/domain/errors/inventory.ts`

Add **after** existing errors (append, never reorder existing):

```ts
export class SuggestionNotConfirmedError extends DomainError {
  constructor(id: string) {
    super(`Inventory suggestion ${id} is not confirmed`, 'SUGGESTION_NOT_CONFIRMED');
    this.name = 'SuggestionNotConfirmedError';
  }
}

export class NotADeviceError extends DomainError {
  constructor(id: string) {
    super(`Inventory suggestion ${id} is not a DEVICE`, 'SUGGESTION_NOT_A_DEVICE');
    this.name = 'NotADeviceError';
  }
}

export class SuggestionNotLinkedError extends DomainError {
  constructor(id: string) {
    super(`Inventory suggestion ${id} has no linked contract item`, 'SUGGESTION_NOT_LINKED');
    this.name = 'SuggestionNotLinkedError';
  }
}
```

> Note: `confirmedItemId null` throws `SuggestionNotLinkedError` (SUGGESTION_NOT_LINKED), NOT `SuggestionNotConfirmedError`. This was the reconciliation canonical decision.

Confirm existing errors `SuggestionNotFoundError` (SUGGESTION_NOT_FOUND) and `InstalledItemNotFoundError` (INSTALLED_ITEM_NOT_FOUND) are present; do NOT rename or move them.

### 1.3 [BE] Implement `src/application/use-cases/CorrectConfirmedDeviceType.ts`

Exact signature (from design AD-1):

```ts
export interface CorrectConfirmedDeviceTypeInput {
  suggestionId: string;
  newType: string; // received already UPPERCASE from route
}

export class CorrectConfirmedDeviceType {
  constructor(
    private readonly suggestions: InventorySuggestionRepository,
    private readonly inventory: ContractInventoryRepository,
  ) {}

  async execute(input: CorrectConfirmedDeviceTypeInput): Promise<InstalledItemDto> { ... }
}
```

Ordered guards (fail-fast):
1. `suggestions.get(id)` → null → `SuggestionNotFoundError`
2. `s.kind !== 'DEVICE'` → `NotADeviceError`
3. `s.status !== 'confirmed'` → `SuggestionNotConfirmedError`
4. `s.confirmedItemId == null` → `SuggestionNotLinkedError` ⚠️ (NOT SuggestionNotConfirmedError — see reconciliation)
5. `inventory.update(s.confirmedItemId, { type: input.newType })` → null → `InstalledItemNotFoundError`
6. `suggestions.setStatus(s.id, 'confirmed', s.confirmedItemId, input.newType)` — reuse existing param (AD-2)
7. `return toInstalledItemDto(item, null)` — `addedByUserName` null (AD-3)

No new repo methods. No `SchedulingRepository` dep. Imports: `@domain/ports/...`, `@domain/errors/inventory`, `@application/dto/InstalledItemDto`.

### 1.4 [TEST] Green: run `CorrectConfirmedDeviceType.test.ts`

All 8 cases in 1.1 must pass. Verify the happy-path test asserts BOTH `suggestions.get(id).deviceType` AND `inventory.getById(confirmedItemId).type` equal the new value — this is the core correctness check (the bug from tarea 4691).

---

## B2 — BE: Route + DI wiring + 2 call-site fixes

> ⚠️ HOTSPOT: `createContractInventoryRouter` signature changes; ALL call-sites break. There are exactly 2:
> 1. `src/infrastructure/http/app.ts` (production DI)
> 2. `src/__tests__/infrastructure/serviceInventory.routes.test.ts` (test DI)
> Both must be updated in this batch atomically.

### 2.1 [TEST] Red: extend `serviceInventory.routes.test.ts`

Before touching the route or DI, add failing test cases to `src/__tests__/infrastructure/serviceInventory.routes.test.ts`:

- `PATCH .../type with valid UPPERCASE type → 200 + InstalledItemDto (both repos updated)`
- `PATCH .../type with valid lowercase type → 200 + persists ANTENA (route normalises)`
- `PATCH .../type with invalid type (SUBMARINO) → 422 INVALID_ITEM_TYPE`
- `PATCH .../type suggestion is pending → 409 SUGGESTION_NOT_CONFIRMED`
- `PATCH .../type suggestion is MATERIAL confirmed → 409 SUGGESTION_NOT_A_DEVICE`
- `PATCH .../type confirmedItemId null → 409 SUGGESTION_NOT_LINKED`
- `PATCH .../type no inventory.manage permission → 403` (second `buildApp` with `manage: deny`)
- `GET .../suggestions → response includes match field on each item` (at least one `same_device` case)

These tests will fail because `createContractInventoryRouter` does not yet accept `correctType` and `InventoryRoutePerms` does not have `manage`. That is the intended red state.

> ⚠️ Call-site fix #2 lives here: update `buildApp` helper in the test file to pass `correctType` and add `manage: pass` to the perms object.

### 2.2 [BE] Extend `InventoryRoutePerms` and add `manage` perm in `contractInventory.routes.ts`

In `src/infrastructure/http/routes/contractInventory.routes.ts`:

1. Add `manage: RequestHandler` to the `InventoryRoutePerms` interface (~line 27).
2. Add `correctType: CorrectConfirmedDeviceType` parameter to `createContractInventoryRouter` — place it after `discard` (semantic neighbour), before `auth` guard object, to maintain positional clarity.
3. Import `CorrectConfirmedDeviceType`, `SuggestionNotConfirmedError`, `NotADeviceError`, `SuggestionNotLinkedError` from their canonical paths.

### 2.3 [BE] Add PATCH handler in `contractInventory.routes.ts`

Handler at `PATCH /scheduling/:taskId/inventory/suggestions/:suggestionId/type`, guarded by `auth, perms.manage`:

```ts
router.patch(
  '/scheduling/:taskId/inventory/suggestions/:suggestionId/type',
  auth, perms.manage,
  async (req, res, next) => {
    try {
      const rawType = (req.body as { type?: unknown } | undefined)?.type;
      if (!(await deviceTypes.isValid(rawType as string))) {
        res.status(422).json({ error: 'Invalid item type', code: 'INVALID_ITEM_TYPE' });
        return;
      }
      const item = await correctType.execute({
        suggestionId: req.params.suggestionId,
        newType: (rawType as string).toUpperCase(),
      });
      res.json(item);
    } catch (e) {
      if (e instanceof SuggestionNotConfirmedError || e instanceof NotADeviceError || e instanceof SuggestionNotLinkedError) {
        res.status(409).json({ error: (e as DomainError).message, code: (e as DomainError).code });
        return;
      }
      if (e instanceof SuggestionNotFoundError || e instanceof InstalledItemNotFoundError) {
        res.status(404).json({ error: (e as DomainError).message, code: (e as DomainError).code });
        return;
      }
      next(e);
    }
  },
);
```

Status code mapping:
- 422 — type not in catalog (validated before use-case call)
- 409 — state conflict: SUGGESTION_NOT_CONFIRMED, SUGGESTION_NOT_A_DEVICE, SUGGESTION_NOT_LINKED
- 404 — SUGGESTION_NOT_FOUND, INSTALLED_ITEM_NOT_FOUND

### 2.4 [BE] Update `app.ts` — DI wiring

> ⚠️ Call-site fix #1 lives here.

In `src/infrastructure/http/app.ts` (~lines 1028-1053):

1. Instantiate: `const correctConfirmedDeviceType = new CorrectConfirmedDeviceType(inventorySuggestionRepo, contractInventoryRepo);`
2. Add `manage: requirePerm('inventory', 'manage')` to the perms object passed to `createContractInventoryRouter`.
3. Pass `correctConfirmedDeviceType` in the new positional slot (after `discard`, matching the order declared in 2.2).
4. Verify `inventory.manage` exists in the RBAC permission seed (`prisma/seed.ts` or equivalent). If the `inventory` module exists with `read`/`write` but not `manage`, add `manage` as a new row — this is a data-only change, no schema migration.

### 2.5 [TEST] Green: run `serviceInventory.routes.test.ts`

All cases added in 2.1 must pass. Confirm both call-sites compile without error.

---

## B3 — BE: `ListTaskInventorySuggestions` enrichment + `computeMatch` + `TaskInventorySuggestionDto`

> B3 depends on B2 being complete (the route test already exercises the GET endpoint, and after B3 the `match` field must appear).

### 3.1 [TEST] Red: create `ListTaskInventorySuggestionsMatch.test.ts`

Write `src/__tests__/application/ListTaskInventorySuggestionsMatch.test.ts` with all cases as failing stubs:

- `same_device by SN (normalisation: "abc-001" matches "ABC-001")`
- `same_device by MAC (suggestion mac "aa:bb:cc:dd:ee:ff" matches item "AABBCCDDEEFF" after strip)`

  > ⚠️ MAC normalisation: trim + uppercase + strip `:` and `-` (apply to BOTH suggestion mac and item mac).

- `same_device by SN even when MAC differs`
- `same_type (same type, different SN/MAC)`
- `null (no match on SN, MAC, or type)`
- `MATERIAL suggestion → match always null`
- `removed item excluded → match null despite SN coincidence`
- `task without contractId → all null, no error thrown`
- `priority: same_device wins over same_type (SN + type both coincide → same_device)`
- `SN empty string after trim → treated as null (no match)`

### 3.2 [BE] Create `src/application/dto/TaskInventorySuggestionDto.ts`

```ts
export type MatchStatus = 'same_device' | 'same_type';

export interface SuggestionMatch {
  status: MatchStatus;
  itemId: string;
  serial: string | null;
}

export interface TaskInventorySuggestionDto extends TaskInventorySuggestion {
  match: SuggestionMatch | null;
}

export function toTaskInventorySuggestionDto(
  s: TaskInventorySuggestion,
  match: SuggestionMatch | null,
): TaskInventorySuggestionDto {
  return { ...s, match };
}
```

### 3.3 [BE] Implement `computeMatch` helper

Pure function in `src/application/use-cases/ListTaskInventorySuggestions.ts` (or a co-located helper exported for testing). Normalisation rules:

- SN: `trim + toUpperCase`, empty string → null
- MAC: `trim + toUpperCase + strip `:` and `-``, empty string → null

```ts
const normSn = (v: string | null | undefined): string | null =>
  v == null ? null : v.trim().toUpperCase() || null;

const normMac = (v: string | null | undefined): string | null => {
  if (v == null) return null;
  const s = v.trim().toUpperCase().replace(/[:\-]/g, '');
  return s || null;
};
```

Match logic (from design AD-9):
1. `kind !== 'DEVICE'` → `null`
2. Find `byIdentity`: item where `normSn(i.serialNumber) === sn` (when sn != null) **or** `normMac(i.mac) === mac` (when mac != null)
3. If found → `{ status: 'same_device', itemId: byIdentity.id, serial: byIdentity.serialNumber }`
4. Find `byType`: item where `norm(i.type) === norm(s.deviceType)` (when deviceType != null)
5. If found → `{ status: 'same_type', itemId: byType.id, serial: byType.serialNumber }`
6. → `null`

`same_device` always takes precedence (AD-9, spec F2-8).

### 3.4 [BE] Update `ListTaskInventorySuggestions` — new signature + enrichment

> ⚠️ HOTSPOT: constructor signature changes (2 new deps). This breaks its instantiation in `app.ts` (call-site #1 already handled in 2.4 — confirm the args count now matches).

New constructor:
```ts
constructor(
  private readonly suggestions: InventorySuggestionRepository,
  private readonly inventory: ContractInventoryRepository,
  private readonly scheduling: SchedulingRepository,
) {}

async execute(taskId: string): Promise<TaskInventorySuggestionDto[]>
```

Enrichment flow (from design AD-7):
1. `const list = await this.suggestions.listByTask(taskId)`
2. `const task = await this.scheduling.getTask(taskId); const contractId = task?.contractId ?? null`
3. If `contractId == null` → `return list.map(s => toTaskInventorySuggestionDto(s, null))`
4. `const items = (await this.inventory.listByContract(contractId)).filter(i => i.status !== 'removed')`
5. `return list.map(s => toTaskInventorySuggestionDto(s, computeMatch(s, items)))`

> Only active items (`status !== 'removed'`) participate in matching (spec F2-6, design AD-7).

### 3.5 [BE] Update `app.ts` — pass new deps to `ListTaskInventorySuggestions`

> ⚠️ HOTSPOT call-site: the `ListTaskInventorySuggestions` constructor now takes 3 args. Update the instantiation in `app.ts` to pass `inventorySuggestionRepo, contractInventoryRepo, schedulingRepo`.

Also update `serviceInventory.routes.test.ts` `buildApp` helper if it independently instantiates `ListTaskInventorySuggestions` (check; likely it reuses the shared factory — if so, just confirm the args compile).

### 3.6 [TEST] Green: run `ListTaskInventorySuggestionsMatch.test.ts` + full `serviceInventory.routes.test.ts`

All match unit tests pass. The GET route test case `response includes match field (same_device)` passes.

---

## B4 — FE: Types + API fn + hook + `SuggestionCard` editor + `contractId` threading

> B4 depends on B2+B3 (BE endpoint and response shape are stable).

### 4.1 [TEST] Red: `SuggestionCard` editor rendering tests

Add to `src/__tests__/components/SuggestionCard.test.tsx` (or create if it doesn't exist):

- `renders edit-type control when user has inventory.manage` — mock `useMyPermissions` / `Can` to return `can('inventory.manage') === true`; render a confirmed DEVICE card; assert an edit control (button or select) is visible.
- `does NOT render edit-type control without inventory.manage` — mock returns false; same card; assert no edit control.
- `onCorrectType callback called with (id, selectedType) on save`
- `isCorrecting=true disables the save button / shows loading state`

Mock pattern: reuse `__tests__/components/auth/Can.test.tsx` approach.

### 4.2 [TEST] Red: `useCorrectSuggestionType` invalidation test

Add to the `useServiceInventory` test file (or create `useCorrectSuggestionType.test.ts`):

- `onSuccess invalidates ['task-inventory-suggestions', taskId]`
- `onSuccess invalidates ['service-inventory', contractId] when contractId provided`
- `onSuccess invalidates ['service-inventory'] broadly when no contractId`

### 4.3 [FE] Add `match` type to `src/types/serviceInventory.ts`

Append to `TaskInventorySuggestion` interface:

```ts
match?: {
  status: 'same_device' | 'same_type';
  itemId: string;
  serial: string | null;
} | null;
```

Optional (`?`) — degrades gracefully if BE doesn't send it (spec CC-2).

### 4.4 [FE] Add `correctSuggestionType` to `src/api/serviceInventory.api.ts`

```ts
export const correctSuggestionType = (
  taskId: string,
  suggestionId: string,
  type: string,
) =>
  axiosClient
    .patch<ServiceInstalledItem>(
      `/scheduling/${taskId}/inventory/suggestions/${suggestionId}/type`,
      { type },
    )
    .then(r => r.data);
```

### 4.5 [FE] Add `useCorrectSuggestionType` to `src/hooks/useServiceInventory.ts`

Mirror the pattern of `useConfirmSuggestion` (lines 51-74):

```ts
export function useCorrectSuggestionType(taskId: string, contractId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ suggestionId, type }: { suggestionId: string; type: string }) =>
      api.correctSuggestionType(taskId, suggestionId, type),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: suggestionsKey(taskId) });
      if (contractId) {
        void qc.invalidateQueries({ queryKey: itemsKey(contractId) });
      } else {
        void qc.invalidateQueries({ queryKey: ['service-inventory'] });
      }
    },
  });
}
```

### 4.6 [FE] Thread `contractId` through `TaskTabs` → `TaskInventorySuggestions`

> ⚠️ HOTSPOT: Without `contractId` threading, `useCorrectSuggestionType` falls back to the broad `['service-inventory']` invalidation — sidebar won't refresh precisely. This is what reproduced the original bug.

Files affected (design AD-12bis):
- `src/pages/scheduling/SchedulingTaskDetailPage/components/TaskTabs.tsx` (~lines 39-45, 71, 114): receive `contractId?: string` prop; pass it down to `InventoryPanel` / the component that renders `TaskInventorySuggestions`.
- `src/pages/scheduling/SchedulingTaskDetailPage/components/TaskInventorySuggestions.tsx` (~line 21): accept `contractId?: string` prop; pass to `useConfirmSuggestion(taskId, contractId)` AND `useCorrectSuggestionType(taskId, contractId)`.

Verify that `contractId` is available at the `TaskTabs` call-site (aguas arriba via `CustomerSidebar.tsx` / `ContractInventoryReadonly.tsx` — the sidebar already has it).

### 4.7 [FE] Add inline type editor to `SuggestionCard.tsx` (confirmed DEVICE variant)

In the resolved/confirmed DEVICE variant (~line 68-70 where `<span>{s.deviceType ?? FALLBACK_TYPE}</span>` renders):

1. Wrap an editor inside `<Can permission="inventory.manage">`. Outside the `Can` (fallback), keep the existing `<span>` unchanged — non-admin sees no change.
2. Editor: dropdown initialised to `s.deviceType`, using `activeTypes` already computed at ~line 31-33; + "Guardar" button. Toggle pattern (view mode → edit mode on click) to avoid breaking the card layout.
3. "Guardar" calls `onCorrectType?.(s.id, selectedType)` and enters `isCorrecting` state.

New props to add to `SuggestionCard`:
```ts
onCorrectType?: (id: string, type: string) => void;
isCorrecting?: boolean;
```

The card does NOT call hooks or check permissions directly for the editor — it uses `<Can>` (consistent with project pattern, `Can.tsx`).

### 4.8 [FE] Wire `useCorrectSuggestionType` in `TaskInventorySuggestions.tsx`

Call `useCorrectSuggestionType(taskId, contractId)` and pass `mutate` as `onCorrectType` and `isPending` as `isCorrecting` to `SuggestionCard`.

### 4.9 [TEST] Green: editor tests pass

All cases from 4.1 and 4.2 pass.

---

## B5 — FE: Match badge in `SuggestionCard`

> B5 depends on B4 (the `match` type exists on the suggestion).

### 5.1 [TEST] Red: `SuggestionCard` match badge tests

Add to the existing `SuggestionCard` test file:

- `same_device → warning badge "Ya instalado: el mismo equipo" visible`
- `same_device with serial → badge includes serial`
- `same_type with deviceType=ONU → info badge "Ya hay un/a ONU" visible`
- `match=null → no badge rendered`
- `match field absent (undefined) → no badge rendered (graceful degradation, spec CC-2)`

### 5.2 [FE] Implement match badge in `SuggestionCard.tsx`

Below or near the type/meta area (show in BOTH pending and confirmed variants — badge warns before confirming and traces after):

```tsx
{s.match != null && (
  <MatchBadge match={s.match} deviceType={s.deviceType} />
)}
```

Where `MatchBadge` can be an inline component or small helper:
- `same_device` → warning-style badge "⚠️ Ya instalado: el mismo equipo" + `{s.match.serial}` if non-null.
- `same_type` → info-style badge `"Ya hay un/a {deviceType}"`.

No permission gating — badge is read-only (`inventory.read`, already covered by the listing gate).

### 5.3 [TEST] Green: badge tests pass

All 5 cases from 5.1 pass.

---

## B6 — Verify: full compile + full test suites

> B6 has no code to write. It is a green-light gate before push.

### 6.1 [TEST] TypeScript compile check — BE

```bash
npx tsc --noEmit
```

Expected: 0 errors. Common failure points:
- `createContractInventoryRouter` arity mismatch in `app.ts` or test helper
- `ListTaskInventorySuggestions` constructor arity in `app.ts`
- Missing import of `SuggestionNotLinkedError` in route or use-case
- `TaskInventorySuggestionDto` not imported in route serialization

### 6.2 [TEST] Full Jest suite — BE

```bash
npm test
```

Must pass:
- `CorrectConfirmedDeviceType.test.ts` — 8 cases
- `ListTaskInventorySuggestionsMatch.test.ts` — 10 cases
- `serviceInventory.routes.test.ts` — all existing + 9 new cases
- All pre-existing tests unbroken (regression gate)

### 6.3 [TEST] TypeScript compile check — FE

In the FE repo:
```bash
npx tsc --noEmit
```

Common failure points:
- `TaskInventorySuggestion` missing `match` import where used
- `SuggestionCard` prop types not updated at call-sites
- `TaskInventorySuggestions` / `TaskTabs` missing `contractId` prop at their call-sites

### 6.4 [TEST] Full Vitest suite — FE

```bash
npx vitest run
```

Must pass:
- `SuggestionCard.test.tsx` — editor gating + badge cases
- `useCorrectSuggestionType` invalidation test
- All pre-existing tests unbroken

### 6.5 [MANUAL] Smoke test — tarea 4691 scenario

1. Open a task with a confirmed DEVICE suggestion (e.g. the ONU).
2. As admin (with `inventory.manage`): edit type to ANTENA → save.
3. Verify: suggestion card shows ANTENA **and** contract sidebar shows ANTENA (both synced — this was the original bug).
4. As non-admin: confirm no edit control visible.
5. Open any task with an existing contract item; add a suggestion for the same SN → verify `same_device` badge appears.
6. Add a suggestion of same type, different SN → verify `same_type` badge appears.
7. Deploy order: BE before FE; FE must degrade without badge / without PATCH endpoint gracefully.

---

## Hotspot summary

| Hotspot | Location | Batch | Risk |
|---------|----------|-------|------|
| `SuggestionNotLinkedError` is NEW (not NOT_CONFIRMED) | `errors/inventory.ts`, use-case step 4, route catch | B1/B2 | Reconciliation canonical — must not slip back to SuggestionNotConfirmedError |
| `createContractInventoryRouter` new param | `contractInventory.routes.ts`, `app.ts`, test helper | B2 | 2 call-sites break atomically — fix both in same batch |
| `ListTaskInventorySuggestions` new constructor arity | `ListTaskInventorySuggestions.ts`, `app.ts` | B3 | 1 call-site; B3.5 handles it |
| MAC normalisation: strip `:` AND `-` | `computeMatch`, test cases | B3 | Apply to BOTH suggestion mac AND item mac before comparing |
| `contractId` threading | `TaskTabs` → `TaskInventorySuggestions` | B4 | Without it, sidebar invalidation is imprecise (reproduces the original bug partially) |
| `inventory.manage` in RBAC seed | `prisma/seed.ts` | B2 | Data-only; verify before wiring the route or it will 403 in prod |

---

## File-count estimate

**BE new files**: 3
- `src/application/use-cases/CorrectConfirmedDeviceType.ts`
- `src/application/dto/TaskInventorySuggestionDto.ts`
- `src/__tests__/application/CorrectConfirmedDeviceType.test.ts`

**BE modified files**: 6
- `src/domain/errors/inventory.ts` (+3 errors)
- `src/application/use-cases/ListTaskInventorySuggestions.ts` (+2 deps, returns DTO, +computeMatch)
- `src/infrastructure/http/routes/contractInventory.routes.ts` (+PATCH handler, +manage perm, +correctType param)
- `src/infrastructure/http/app.ts` (+instantiate CorrectConfirmedDeviceType, +manage perm, update ListTaskInventorySuggestions args)
- `src/__tests__/application/ListTaskInventorySuggestionsMatch.test.ts` (new or extension)
- `src/__tests__/infrastructure/serviceInventory.routes.test.ts` (+9 cases, updated buildApp)

**BE conditional**: 1
- `prisma/seed.ts` — only if `inventory.manage` missing in RBAC

**FE new files**: 0

**FE modified files**: 6
- `src/types/serviceInventory.ts` (+match field)
- `src/api/serviceInventory.api.ts` (+correctSuggestionType)
- `src/hooks/useServiceInventory.ts` (+useCorrectSuggestionType)
- `src/pages/scheduling/SchedulingTaskDetailPage/components/SuggestionCard.tsx` (+editor + badge)
- `src/pages/scheduling/SchedulingTaskDetailPage/components/TaskInventorySuggestions.tsx` (+contractId prop, +useCorrectSuggestionType)
- `src/pages/scheduling/SchedulingTaskDetailPage/components/TaskTabs.tsx` (+contractId threading)

**FE test files**: 2 modified (SuggestionCard.test.tsx, useServiceInventory test)

**Total**: ~9 BE files (3 new + 6 modified) + ~8 FE files (0 new + 6 modified + 2 test).

---

## Recommended batch grouping for apply

| Batch | Contents | Who | Blocker for |
|-------|----------|-----|-------------|
| B1 | Domain errors + CorrectConfirmedDeviceType use-case + tests | BE | B2 |
| B2 | Route PATCH + DI + 2 call-site fixes + route tests | BE | B3, B4 |
| B3 | ListTaskInventorySuggestions enrichment + computeMatch + DTO + tests | BE | B4, B5 |
| B4 | FE types + api + hook + editor + contractId threading + editor tests | FE | B5 |
| B5 | FE match badge + badge tests | FE | B6 |
| B6 | tsc + jest + vitest + smoke | ALL | push |
