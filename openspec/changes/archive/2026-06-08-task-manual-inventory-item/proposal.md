# Proposal: Manual Inventory Item on Task (backlog #19)

## Intent

Operators cannot register a device/material that OCR or IClass missed; the only manual path (`AddInstalledItemManually`) bypasses staging/review. #19 adds a manual entry that joins the normal confirm/discard flow as `source='MANUAL'`.

## Scope

### In Scope
- BE use case `CreateManualSuggestion` (DEVICE: catalog type + SN/MAC; MATERIAL: description + qty/unit) → `TaskInventorySuggestion` `source='MANUAL'`, `status='pending'`.
- BE route `POST /scheduling/:taskId/inventory/suggestions`, permission `inventory.write`.
- Fix source mapping in `ConfirmInventorySuggestion`: pass-through (today `'OCR' ? 'OCR' : 'ICLASS'` labels MANUAL as ICLASS).
- New `create()` port method on `InventorySuggestionRepository` — MANUAL never upsert-clobbers OCR rows.
- Extract #18's `assertComplete` to a shared domain function; fail-fast at creation (`IncompleteSuggestionError` → 422).
- FE "Agregar ítem" button + inline form in `TaskInventorySuggestions`, ALWAYS visible (empty and non-empty states), gated `inventory.write`; `useCreateManualSuggestion` hook; `MANUAL` sourceLabel in `SuggestionCard`.
- Multi-repo: one PR per repo (BE + FE), independent commits.

### Out of Scope
- Stock management; editing existing manual suggestions; photo upload for manual items.
- DB migration (`source` is a free String; schema comment update only).

## Capabilities

### New Capabilities
- `task-manual-suggestion`: manual creation of inventory suggestions on a task (endpoint, validation, FE form/button, permission gating).

### Modified Capabilities
- `service-inventory`: confirm flow propagates the suggestion's `source` verbatim to the installed item (MANUAL stays MANUAL); suggestion `source` enum gains `MANUAL`.

## Approach

Approach A from exploration: new use case + POST route; the manual suggestion reuses the confirm/replace/discard pipeline untouched. Dedicated `create()` (not `upsert`): the natural key `(taskId, kind, sn, mac, materialDesc)` is source-blind — MANUAL would overwrite OCR data (photoUrl, qwenDeviceType). Validation shared via a pure domain function: `CreateManualSuggestion` (fail-fast) and `ConfirmInventorySuggestion` (fail-closed).

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/application/use-cases/CreateManualSuggestion.ts` | New | Use case |
| `src/application/use-cases/ConfirmInventorySuggestion.ts` | Modified | Source pass-through, shared validation |
| `src/domain/` | Modified | Validation fn, `create()` on port |
| `routes/contractInventory.routes.ts`, `app.ts` | Modified | POST route, wiring |
| FE `TaskInventorySuggestions.tsx`, `SuggestionCard.tsx`, `useServiceInventory.ts`, `serviceInventory.api.ts` | Modified | Button, form, hook, label |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| MANUAL labeled ICLASS on confirm | High | Pass-through fix + test |
| MANUAL upsert clobbers OCR row | Med | Dedicated `create()` |
| Empty-state early-return hides button | Med | Render in both states; FE test |
| Validation drift BE/FE | Low | Shared domain fn; FE mirrors `incomplete` |

## Rollback Plan

Revert the two PRs (BE, FE) independently — no migration, no backfill. Existing MANUAL suggestions remain valid rows (`source` is a free string) and can be discarded via the existing pipeline.

## Dependencies

- #18 fail-closed validation (`IncompleteSuggestionError`, in-flight `iclass-closure-loop` change) — already in `src/domain/errors/inventory.ts`.

## Success Criteria

- [ ] POST creates a pending MANUAL suggestion; 422 `SUGGESTION_INCOMPLETE` on incomplete input; 403 without `inventory.write`.
- [ ] Confirming a MANUAL suggestion yields a contract item with `source='MANUAL'`.
- [ ] "Agregar ítem" visible in empty AND non-empty states, hidden without `inventory.write`.
- [ ] MANUAL create never overwrites an existing OCR suggestion (same SN/MAC).
- [ ] BE + FE suites green (strict TDD: tests first).
