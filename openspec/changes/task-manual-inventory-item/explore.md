# Exploration: task-manual-inventory-item (backlog #19)

## Question 1 — `AddInstalledItemManually`: what does it do and what's missing?

`AddInstalledItemManually` (`src/application/use-cases/AddInstalledItemManually.ts`) adds a device **directly to the contract** (`ContractInstalledItem`, table `ContractInstalledItem`) with `source='MANUAL'` and `sourceTaskId=null`. It is exposed at `POST /contracts/:contractId/inventory` (permission: `inventory.write`, guard `perms.contractWrite`). It does NOT create a `TaskInventorySuggestion` — it bypasses the staging/suggestion pipeline entirely.

What's missing for #19:
- A new use case `CreateManualSuggestion` that inserts a `TaskInventorySuggestion` with `source='MANUAL'` into the staging table (not directly into the contract).
- A new route `POST /scheduling/:taskId/inventory/suggestions` (permission: `inventory.write`).
- The FE "Agregar ítem" button + inline form inside `TaskInventorySuggestions`.
- Critically: the manual suggestion goes through the same confirm/discard pipeline as OCR suggestions, so the operator still reviews it before it hits the contract. `AddInstalledItemManually` is an orthogonal shortcut (no staging, no per-task tracking), NOT a solution for #19.

## Question 2 — Suggestion model: fields, source values, migration needed?

Table: `TaskInventorySuggestion` (Prisma model). Key fields:
- `source String` — comment says `OCR | ICLASS_MATERIAL`. This is a plain string (no DB enum), so `MANUAL` can be stored without a migration. The domain entity type also declares `source: string`.
- `kind String` — `DEVICE | MATERIAL`.
- `status String @default("pending")` — `pending | confirmed | discarded`.
- `taskId String` — FK to `ScheduledTask`.
- `serialNumber`, `mac`, `materialDesc`, `quantity`, `unit`, `deviceType`, `qwenDeviceType`, `photoUrl` — all optional.

On confirm: `ConfirmInventorySuggestion.execute()` routes by `kind`:
- `DEVICE` → creates `ContractInstalledItem` (source mapped: `suggestion.source === 'OCR' ? 'OCR' : 'ICLASS'`). **Problem**: this mapping will map `source='MANUAL'` to `'ICLASS'` on the confirmed item. The `ConfirmInventorySuggestion` needs a small update to pass `source='MANUAL'` through when the suggestion source is MANUAL.
- `MATERIAL` → creates `TaskMaterialConsumption`.

**No DB migration needed** for adding `source='MANUAL'` to suggestions. However the `source` comment in schema (line 794) should be updated to `OCR | ICLASS_MATERIAL | MANUAL` for documentation.

Upsert natural key in `PrismaInventorySuggestionRepository`: `(taskId, kind, serialNumber, mac, materialDesc)`. A MANUAL suggestion with a specific SN/MAC would upsert with OCR suggestions if they share the same natural key — this could be a conflict but is unlikely in practice (an OCR suggestion already exists only if the closure-loop ran). The use case should use `upsert` or `create` — creating directly (bypassing natural-key deduplication) is preferable for MANUAL items to avoid overwriting OCR data.

## Question 3 — #18 validation: `IncompleteSuggestionError` location and reusability

`IncompleteSuggestionError` is a domain error in `src/domain/errors/inventory.ts`. The guard itself lives as a private `assertComplete(s)` method on `ConfirmInventorySuggestion`:
```
if (s.kind === 'DEVICE') { if (!s.serialNumber?.trim() && !s.mac?.trim()) throw IncompleteSuggestionError }
else { if (!s.materialDesc?.trim()) throw IncompleteSuggestionError }
```
For `CreateManualSuggestion`, the same validation should be applied **at creation time** (fail-fast: reject the request before inserting into the staging table). Two options:
- Extract `assertComplete` to a pure domain function in `src/domain/` (e.g., `validateSuggestionCompleteness`) and call it from both use cases.
- Duplicate the guard inline in `CreateManualSuggestion` (simpler, less sharing).
The domain-function approach is cleaner and avoids drift. The `IncompleteSuggestionError` is already in `@domain/errors/inventory` so it's available to both use cases without layer violations.

The FE also mirrors this guard (`SuggestionCard.tsx` line 98-100: `incomplete` flag). The "Agregar ítem" form should show the same inline hint (`styles.incompleteHint`) before the submit button.

## Question 4 — BE routes under `/scheduling/:taskId/inventory`

All defined in `src/infrastructure/http/routes/contractInventory.routes.ts` (re-exported from `serviceInventory.routes.ts`):

| Method | Path | Permission | Use case |
|--------|------|------------|----------|
| GET | `/scheduling/:taskId/inventory/suggestions` | `scheduling.read` (`perms.taskRead`) | `ListTaskInventorySuggestions` |
| POST | `/scheduling/:taskId/inventory/suggestions/:id/confirm` | `scheduling.write` (`perms.taskWrite`) | `ConfirmInventorySuggestion.execute()` |
| POST | `/scheduling/:taskId/inventory/suggestions/:id/replace` | `inventory.write` (`perms.contractWrite`) | `ConfirmInventorySuggestion.replace()` |
| POST | `/scheduling/:taskId/inventory/suggestions/:id/discard` | `scheduling.write` (`perms.taskWrite`) | `DiscardInventorySuggestion` |
| PATCH | `/scheduling/:taskId/inventory/suggestions/:id/type` | `inventory.manage` (`perms.manage`) | `CorrectConfirmedDeviceType` |
| GET | `/scheduling/:taskId/inventory/materials` | `scheduling.read` | `ListTaskMaterialConsumptions` |
| POST | `/scheduling/:taskId/inventory/materials` | `inventory.write` (`perms.materialWrite`) | `RecordMaterialConsumption` |
| DELETE | `/scheduling/:taskId/inventory/materials/:id` | `inventory.write` | `DeleteMaterialConsumption` |

**Missing**: `POST /scheduling/:taskId/inventory/suggestions` — the new endpoint for #19. Permission should be `inventory.write` (per the backlog spec). This inserts a MANUAL `TaskInventorySuggestion` into the staging table; the operator then confirms/discards it like any other suggestion.

## Question 5 — FE panel: structure, empty state, hooks, form patterns

### `TaskInventorySuggestions` (main panel)
- File: `src/pages/scheduling/SchedulingTaskDetailPage/components/TaskInventorySuggestions.tsx`
- Fetches via `useTaskInventorySuggestions(taskId)` → TanStack Query → `GET /scheduling/:taskId/inventory/suggestions`.
- Empty state (line 40-47): a `<p className={styles.muted}>` message. **This is where "Agregar ítem" button needs to be added** — shown ALWAYS (even in the empty state), gated by `inventory.write`.
- Pending suggestions rendered as `SuggestionCard` list; resolved ones in a `styles.resolved` div.

### `SuggestionCard`
- Uses `useDeviceTypes()` (from `src/hooks/useDeviceTypes.ts`) to populate the type dropdown.
- Has an `incomplete` flag that mirrors the BE `assertComplete` guard — shows `styles.incompleteHint` inline.
- `source` values currently handled: `'OCR'`, `'CHECKLIST_TEXT'`, anything else → `'IClass'` (`sourceLabel` fn). A new label for `'MANUAL'` should be added: e.g. `'manual'`.

### Existing form patterns to mirror
- The inline type editor on resolved cards (lines 137-186 of `SuggestionCard.tsx`) shows the pattern: local `useState` for toggle + select + save/cancel buttons.
- The `incompleteHint` pattern (line 236-239) shows how to surface the BE validation mirror in the FE.
- For the "Agregar ítem" form: best fit is a small inline form inside `TaskInventorySuggestions` (not a modal), with:
  - Kind selector: DEVICE / MATERIAL
  - For DEVICE: type dropdown (`useDeviceTypes`), SN input, MAC input
  - For MATERIAL: description text input, quantity, unit
  - Submit gated on completeness (mirrors `incomplete` logic)
  - `incompleteHint` shown if user tries to submit empty

### Hooks available
- `useDeviceTypes()` — active catalog, already used by `SuggestionCard`
- `useMaterialTypes()` — material catalog (`src/hooks/useMaterialTypes.ts`)
- A new `useCreateManualSuggestion(taskId)` mutation hook needs to be added to `useServiceInventory.ts`

## Question 6 — Tests: which files to extend

### Backend
- `src/__tests__/application/ServiceInventory.test.ts` — primary BE test file. Extend with a `describe('CreateManualSuggestion')` block covering: DEVICE happy path (SN only, MAC only, both), MATERIAL happy path, DEVICE without SN/MAC → SUGGESTION_INCOMPLETE, MATERIAL without description → SUGGESTION_INCOMPLETE, task not found → error.
- `src/__tests__/infrastructure/serviceInventory.routes.test.ts` — integration tests for the routes. Extend with tests for the new `POST /scheduling/:taskId/inventory/suggestions` endpoint: 201 on valid DEVICE, 201 on valid MATERIAL, 422 on incomplete, 403 on wrong permission, 422 on invalid device type.

### Frontend
- `src/__tests__/scheduling/SuggestionCard.test.tsx` — already covers `SuggestionCard`. May need extension for MANUAL `source` badge label.
- **New test file needed**: `src/__tests__/scheduling/components/TaskInventorySuggestions.test.tsx` — covers the panel with empty state + "Agregar ítem" button visibility + form submission.
- `src/__tests__/hooks/useConfirmSuggestion.test.ts` — no changes needed (confirm flow unchanged).

## Current State

The suggestion staging pipeline is complete (OCR + IClass → suggest → operator confirms/discards → contract). What doesn't exist: any path to INSERT a suggestion manually. The FE empty state has no affordance for manual entry. The BE has no endpoint to create a suggestion from the FE.

## Affected Areas

**Backend:**
- `src/domain/entities/task-inventory-suggestion.ts` — no change needed (source is `string`, MANUAL is valid as-is)
- `src/domain/errors/inventory.ts` — no change needed (IncompleteSuggestionError already there)
- `src/application/use-cases/ConfirmInventorySuggestion.ts` — small change: map `source='MANUAL'` to `'MANUAL'` on the ContractInstalledItem (currently: `suggestion.source === 'OCR' ? 'OCR' : 'ICLASS'`)
- `src/application/use-cases/CreateManualSuggestion.ts` — **NEW**
- `src/infrastructure/http/routes/contractInventory.routes.ts` — add `POST /scheduling/:taskId/inventory/suggestions`
- `src/infrastructure/http/app.ts` — wire `CreateManualSuggestion` into the router factory
- `src/__tests__/application/ServiceInventory.test.ts` — extend
- `src/__tests__/infrastructure/serviceInventory.routes.test.ts` — extend
- `prisma/schema.prisma` — comment update only (no migration)

**Frontend:**
- `src/pages/scheduling/SchedulingTaskDetailPage/components/TaskInventorySuggestions.tsx` — add "Agregar ítem" button + inline form
- `src/pages/scheduling/SchedulingTaskDetailPage/components/TaskInventorySuggestions.module.css` — form styles
- `src/pages/scheduling/SchedulingTaskDetailPage/components/SuggestionCard.tsx` — add `'MANUAL'` label in `sourceLabel`
- `src/hooks/useServiceInventory.ts` — add `useCreateManualSuggestion` mutation
- `src/api/serviceInventory.api.ts` — add `createManualSuggestion` API call
- `src/types/serviceInventory.ts` — add `CreateManualSuggestionInput` type
- `src/__tests__/scheduling/components/TaskInventorySuggestions.test.tsx` — **NEW**

## Approaches

### Approach A — New use case `CreateManualSuggestion` + new POST route (RECOMMENDED)

Creates `src/application/use-cases/CreateManualSuggestion.ts`. Inserts a `TaskInventorySuggestion` with `source='MANUAL'`, `status='pending'`, bypassing the natural-key upsert (use a direct `create` via a new port method OR use `upsert` with a unique-enough key like `taskId+kind+sn+mac`). The suggestion then flows through the existing confirm/discard pipeline unchanged.

- Pros: Clean hexagonal, consistent with existing pipeline; all existing confirm/replace/discard logic reusable; FE changes minimal (just the "Agregar ítem" form).
- Cons: A MANUAL suggestion with the same SN/MAC as an OCR suggestion would upsert over it (due to natural-key logic). Mitigation: add a `source` discriminator to the upsert natural key, OR use `create` directly with a new port method.
- Effort: Low-Medium (2-3 BE files, 3-4 FE files)

### Approach B — Extend `AddInstalledItemManually` to optionally accept a `taskId`

Modify `AddInstalledItemManually` to also create a `TaskInventorySuggestion` when `taskId` is provided.

- Pros: Reuses existing use case.
- Cons: Single use case doing two things (SRP violation); the contract item gets created immediately without operator review — that's NOT what #19 wants (it wants the staging step). This breaks the design intent.
- Effort: Low but WRONG approach for #19.

### Approach C — Inline form goes straight to `POST /contracts/:contractId/inventory` (bypass staging)

FE sends the form directly to the existing manual item endpoint, skipping suggestions entirely.

- Pros: No BE changes.
- Cons: No staging/review step; item added without operator seeing a confirm flow; no `sourceTaskId` linkage; doesn't show in the suggestion panel. Against the intent of #19.
- Effort: Minimal but wrong.

## Recommendation

**Approach A** — new `CreateManualSuggestion` use case + `POST /scheduling/:taskId/inventory/suggestions` endpoint + FE inline form.

Fix the `source` propagation bug in `ConfirmInventorySuggestion`: when `suggestion.source === 'MANUAL'`, the confirmed `ContractInstalledItem` should get `source='MANUAL'` (not `'ICLASS'`).

For the upsert concern: add a `create` method to `InventorySuggestionRepository` (separate from `upsert`) so MANUAL suggestions are always inserted fresh without clobbering OCR data. Alternatively, include `source` in the natural-key check in `upsert`.

## Risks

1. **Source propagation in `ConfirmInventorySuggestion`**: the current `source === 'OCR' ? 'OCR' : 'ICLASS'` mapping silently downgrades MANUAL to ICLASS on the contract item. Must be fixed.
2. **Natural-key upsert conflict**: if an OCR suggestion for the same device already exists, a MANUAL suggestion with the same SN/MAC would upsert over it and lose the `photoUrl`/`qwenDeviceType`. Needs a `source`-aware key or a separate `create` path.
3. **Permission**: spec says `inventory.write`. The existing `perms.materialWrite` is already mapped to `inventory.write` — the same guard can be reused for the new endpoint.
4. **Empty state with form**: when the panel is empty, the current `<p>` is returned early (before the list). The "Agregar ítem" affordance must appear in BOTH the empty state and the non-empty state (above or below the suggestion list).
5. **No test file for `TaskInventorySuggestions`**: the component is untested. Strict TDD requires writing the test first.

## Ready for Proposal

Yes. The scope is well-defined. The 6 open questions are answered. Proceed to `sdd-propose`.
